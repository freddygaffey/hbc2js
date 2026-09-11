// src/readability/surfaces.ts -- spec 28 landing 4, section 9.7: the seven
// MCP tools as plain functions over a `ReadabilityContext`. One core
// (`name-pass.ts` / `rewrite.ts` / `file-ops.ts` / `transactions.ts`), three
// callers (UI, MCP, CLI, section 1e) -- this file is the shared surface the
// MCP registration (`src/mcp/tools.ts`) and the UI worker routes
// (`src/ui-server/workers-routes.ts`) both call, so an external agent gets
// exactly the same safety as the UI: nothing here bypasses the oracle or the
// transaction log, and a caller that supplies its own name or code goes
// through the same gate as the model's output.
//
// Like every other file in this directory, this module imports NO transport:
// `ReadabilityContext.backend` is a `WorkerBackend` the caller already built
// (`FakeBackend` in the gate, `HaikuBackend` in production), never
// constructed here.
//
// RESOLVED (docs/PUSHBACK.md P-59): `suggest_names` writes through the
// name-overlay (`NameService`/`OverlayStore`, the rename tool's own storage,
// docs/RENAME.md), NOT the `readability_tx` table `rewrite`/`file_op` use --
// a NAME proposal has no tree file at the point it is made (it operates on
// the raw decompile, same as landing 1's CLI pass), and forging a `path` for
// it would make a `revert` materialise a bogus file into `treeDir`. Names
// stay overlay transactions permanently (spec 28 section 9.5's new
// paragraph), not a stopgap: the overlay chain already gives reversibility
// (`OverlayStore.revert`) and provenance (`NameRecord.source`/`gate`) under
// spec 18's shard/log integrity, same as the rename tool's own CLI review
// loop. `suggest_names`'s own `txIds` still come back empty (a name has no
// transaction id -- section 9.5's `EmittedFile` shape is unchanged), but its
// writes ARE now durable across calls (persisted to `overlayPathFor(ctx)`,
// a per-project sidecar under `projectDir`, never beside the real `.hbc`
// input) and `list_suggestions`/`promote_change`/`revert_change` see them
// via the record's own `rid`, addressed as `suggestionId`. `rewrite_function`
// and `file_op` keep using the transaction log unchanged (P-58's mapping for
// rewrite, `runFileOp` directly for file ops); `list_suggestions` merges
// both sources into one `SuggestionItem` union.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { analyseModule } from "../cfg/index.ts";
import type { ModuleAnalysis } from "../cfg/index.ts";
import { parseHbc } from "../parse/module.ts";
import { analyseModuleParallel } from "../parallel/analysis-pool.ts";
import { NameService, OverlayStore, bindingKey, regId, shortForm } from "../name-overlay/index.ts";
import { rawFrameBodies } from "../name-overlay/frames.ts";
import type { NameRecord } from "../name-overlay/store.ts";
import { listNameable } from "../artifact/frame-queries.ts";
import type { WorkerBackend } from "../workers/backend.ts";
import { runNamePass } from "./name-pass.ts";
import type { NamePassTarget } from "./name-pass.ts";
import { gateRewrite, rewriteRecordToTransaction } from "./rewrite.ts";
import type { FunctionEquivOracle } from "./rewrite.ts";
import { runFileOp } from "./file-ops.ts";
import type { FileOpRequest, TreeEquivOracle } from "./file-ops.ts";
import {
  getTransaction,
  listTransactions,
  promoteTransaction,
  recordTransaction,
  revertTransaction,
  sha256,
} from "./transactions.ts";
import { TransactionRefused } from "./transactions.ts";
import { evaluationModeFor as evaluationModeForBase, MODULE_ROLES, parseReadabilityResult } from "./types.ts";
import type {
  CallSurface,
  EquivProof,
  EvaluationItem,
  EvaluationMode,
  EvaluationReport,
  EvaluatorPlugin,
  ModuleRole,
  NameProposal,
  ReadabilityTransaction,
  RewriteProposal,
} from "./types.ts";
import { runEvaluation } from "./evaluate.ts";

/** Thrown by every surface on a malformed argument -- section 9.7's
 *  "argument validation exactly per the table" -- and by `promote_change`'s
 *  worker-provenance refusal (section 1d). Never thrown for a REJECTED
 *  oracle verdict: that is a normal, reported outcome (`accepted: false`),
 *  not an error. */
export class ReadabilitySurfaceError extends Error {}

/** The shared context every surface runs against. `hbcPath` is the ground
 *  truth the equivalence oracle compares against (D14); it is optional only
 *  for the surfaces that never need it (`list_suggestions`, `revert_change`,
 *  `promote_change`). `who` defaults to `"worker:haiku"`, the section 1
 *  provenance stamp for anything the model itself proposed. */
export interface ReadabilityContext {
  readonly db: DatabaseSync;
  readonly projectDir: string;
  readonly treeDir: string;
  readonly backend: WorkerBackend;
  /** The `src/readability/backends.ts` id `backend` was built from, when the
   *  caller built it that way. Purely informational to this module -- it is
   *  what lets `WorkerRunner` REBUILD the same backend inside
   *  `src/workers/readability-worker.ts`, since a `WorkerBackend` instance
   *  is not structured-clone-safe. A context whose backend was handed in
   *  directly (a test's `FakeBackend`, an MCP caller's own object) leaves it
   *  undefined and simply keeps the in-process path. */
  readonly backendId?: string;
  readonly hbcPath?: string;
  readonly oracle?: TreeEquivOracle;
  readonly functionOracle?: FunctionEquivOracle;
  readonly who?: string;
  /** Where the name-overlay sidecar for this project lives (P-59). Defaults
   *  to a file under `projectDir`, NEVER beside the real `.hbc` input --
   *  `hbcPath` may point at a shared, git-tracked fixture, and a surface
   *  must never write next to it. */
  readonly overlayPath?: string;
  /** spec 28 sections 1d.1 / 9.6 (landing 5): which call surface this context
   *  serves. `evaluationModeFor` uses it to pick a mode -- defaults to `mcp`
   *  (this module's own default caller); a UI route MUST set `"ui"` so an
   *  `evaluate` request can never spawn an evaluator (section 1d.1: a human
   *  is present on the UI surface, and is always the reviewer). */
  readonly surface?: CallSurface;
  /** The evaluator a caller wired for `agent`/`inline-caller` modes (landing
   *  5). Requesting a mode with no plugin wired is the same as requesting
   *  `none` -- opt-in means a caller supplies the plugin, not just the mode
   *  string (section 1d.1: pluggable, never hard-wired). */
  readonly evaluator?: EvaluatorPlugin;
}

/** section 9.6/1d.1's mode selection plus the "opt-in requires a wired
 *  plugin" rule: `none`/`human-ui` (and `agent`/`inline-caller` with no
 *  `ctx.evaluator`) return `undefined` -- no plugin is ever called, so a UI
 *  context can request `evaluate: "agent"` and nothing is spawned. */
async function maybeEvaluate(
  ctx: ReadabilityContext,
  requested: EvaluationMode | undefined,
  items: readonly EvaluationItem[],
): Promise<EvaluationReport | undefined> {
  const mode = evaluationModeForBase({ surface: ctx.surface ?? "mcp", ...(requested !== undefined ? { requested } : {}) });
  if (mode === "none" || mode === "human-ui") return undefined;
  if (ctx.evaluator === undefined) return undefined;
  return runEvaluation(items, ctx.evaluator);
}

/** Per-context analysis cache, keyed by the bytecode file's identity
 *  (path, size, mtime) so an edited/replaced `.hbc` is never served stale.
 *  Kept in a side table rather than on `ReadabilityContext` so the context
 *  stays a plain readonly value a caller can build literally. Fixes the
 *  docs/BUGS.md 2026-09-11 row "loadAnalysis re-parses the whole .hbc per
 *  call, 72 s on the 435-module fixture": a live MCP/UI session calls
 *  `suggest_names`, `classify_module`, `rewrite_function` and
 *  `promote_change` against the same file. */
const ANALYSIS_CACHE = new WeakMap<ReadabilityContext, { readonly key: string; readonly analysis: ModuleAnalysis }>();

function cacheKey(hbcPath: string): string {
  const st = statSync(hbcPath);
  return `${hbcPath}\u0000${String(st.size)}\u0000${String(st.mtimeMs)}`;
}

/** `promoteChange` is a synchronous public surface (`src/ui-server/
 *  readability-routes.ts` calls it inside a sync handler), so it cannot await
 *  the pool. It shares this cache: warm -- the ordinary case, since a promote
 *  follows a `suggest_names` on the same context -- it pays nothing; cold it
 *  takes the serial `analyseModule` path, correct and no slower than before
 *  this change. docs/PUSHBACK.md P-63. */
function loadAnalysisSync(ctx: ReadabilityContext, hbcPath: string): ModuleAnalysis {
  const key = cacheKey(hbcPath);
  const hit = ANALYSIS_CACHE.get(ctx);
  if (hit !== undefined && hit.key === key) return hit.analysis;
  const bytes = new Uint8Array(readFileSync(hbcPath));
  const analysis = analyseModule(parseHbc(bytes), { strictEnv: true });
  ANALYSIS_CACHE.set(ctx, { key, analysis });
  return analysis;
}

async function loadAnalysis(ctx: ReadabilityContext, hbcPath: string): Promise<ModuleAnalysis> {
  const key = cacheKey(hbcPath);
  const hit = ANALYSIS_CACHE.get(ctx);
  if (hit !== undefined && hit.key === key) return hit.analysis;
  const bytes = new Uint8Array(readFileSync(hbcPath));
  // Same analysis `analyseModule(module, { strictEnv: true })` returns, with
  // the per-function stage-A work fanned out across workers when the bundle
  // is big enough to pay for it (docs/perf/PARALLEL-DECOMPILE.md part 2).
  const analysis = await analyseModuleParallel(bytes, { strictEnv: true });
  ANALYSIS_CACHE.set(ctx, { key, analysis });
  return analysis;
}

/** P-59's resolution: the overlay sidecar for `suggest_names`'
 *  `NameProposal`s, `list_suggestions`, `promote_change` and
 *  `revert_change` -- always under `projectDir`, so it works for every
 *  caller (`hbcPath` is not required by the review tools) and never
 *  pollutes a shared fixture directory. */
function overlayPathFor(ctx: ReadabilityContext): string {
  return ctx.overlayPath ?? join(ctx.projectDir, "readability-overlay.names.json");
}

function nameableTargets(analysis: ModuleAnalysis, service: NameService, fns: readonly number[]): NamePassTarget[] {
  const frames = rawFrameBodies(analysis);
  const targets: NamePassTarget[] = [];
  for (const fn of fns) {
    for (const nameable of listNameable(frames, fn, service.store)) {
      const id = regId(fn, nameable.reg);
      targets.push({ bindingId: id, kind: "suggest-name", context: { target: shortForm(id), fn, reg: nameable.reg, source: service.render({ fn }).code } });
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// suggest_names
// ---------------------------------------------------------------------------

export interface SuggestNamesArgs {
  readonly target: { readonly fn: number } | { readonly module: number };
  readonly budgetTokens?: number;
  readonly evaluate?: EvaluationMode;
}

export interface SuggestNamesResult {
  readonly suggestions: readonly NameProposal[];
  readonly equiv: EquivProof;
  readonly txIds: readonly string[];
  readonly evaluation?: EvaluationReport | undefined;
}

function validateTarget(target: SuggestNamesArgs["target"]): void {
  const hasFn = "fn" in target && target.fn !== undefined;
  const hasModule = "module" in target && target.module !== undefined;
  if (hasFn === hasModule) {
    throw new ReadabilitySurfaceError("suggest_names: target must be exactly one of {fn} or {module}");
  }
}

/** Section 9.7's `suggest_names`. `{fn}` proposes names for that one
 *  function's nameable registers; `{module}` proposes names across every
 *  function in the loaded bytecode (landing 4 scope: one bytecode file is one
 *  "module" here, the same shape `tests/support/readability-tree.ts` builds
 *  its fixtures from -- a multi-module bundle's per-module split is
 *  `file-ops.ts`'s `MODULES.json`, not this tool's concern). See the file
 *  header for why `txIds` is empty (P-59). */
export async function suggestNames(ctx: ReadabilityContext, args: SuggestNamesArgs): Promise<SuggestNamesResult> {
  validateTarget(args.target);
  if (ctx.hbcPath === undefined) throw new ReadabilitySurfaceError("suggest_names: ctx.hbcPath is required");
  const analysis = await loadAnalysis(ctx, ctx.hbcPath);
  const overlayPath = overlayPathFor(ctx);
  const service = new NameService(analysis, OverlayStore.load(overlayPath));
  const fns = "fn" in args.target && args.target.fn !== undefined ? [args.target.fn] : analysis.module.functions.map((_, i) => i);
  const targets = nameableTargets(analysis, service, fns);
  const result = await runNamePass(targets, { backend: ctx.backend, service, ...(args.budgetTokens !== undefined ? { budgetTokens: args.budgetTokens } : {}) });
  // Durable across calls (P-59): a live MCP/UI session calls `suggest_names`,
  // `list_suggestions` and `promote_change` as separate invocations, so the
  // write from this call has to survive on disk for the next one to see it.
  service.store.save(overlayPath);
  const suggestions = result.outcomes.map((o) => o.proposal).filter((p): p is NameProposal => p !== undefined);
  const evaluation = await maybeEvaluate(
    ctx,
    args.evaluate,
    suggestions.map((p) => ({ targetId: bindingKey(p.bindingId), proposedName: p.name, confidence: p.confidence, evidence: p.evidence })),
  );
  return { suggestions, equiv: result.equiv, txIds: [], evaluation };
}

// ---------------------------------------------------------------------------
// classify_module
// ---------------------------------------------------------------------------

export interface ClassifyModuleArgs {
  readonly module: number;
  readonly evaluate?: EvaluationMode;
}

export interface ClassifyModuleResult {
  readonly role?: ModuleRole | undefined;
  readonly path?: string;
  readonly confidence: "low" | "med" | "high";
  readonly evidence: string;
  readonly txId?: string;
  readonly evaluation?: EvaluationReport | undefined;
}

/** A small, deterministic keyword match over the model's own evidence text --
 *  the `hbc-classify` skill's output contract (section 9.2) does not pin a
 *  `role` enum field, only names + evidence (the same `ReadabilityResult`
 *  shape `suggest-name` uses), so `classify_module` infers the role from
 *  what the model already said rather than inventing a second, unparsed
 *  output contract. Returns `undefined` on no match rather than guessing. */
export function inferModuleRole(text: string): ModuleRole | undefined {
  const lower = text.toLowerCase();
  return MODULE_ROLES.find((role) => lower.includes(role.replace("-", "")) || lower.includes(role));
}

/** Section 9.7's `classify_module`. Runs the `name-module` job kind over the
 *  module and derives `{role, path, confidence, evidence}` from the top
 *  proposal; abstention or a model that named nothing yields `role:
 *  undefined` at `low` confidence rather than a guess. Writes nothing to the
 *  transaction log (classification is advisory, not a file-tree change), so
 *  `txId` is always `undefined` here -- landing 5's evaluator is the review
 *  path for this tool, same as `suggest_names`. */
export async function classifyModule(ctx: ReadabilityContext, args: ClassifyModuleArgs): Promise<ClassifyModuleResult> {
  if (ctx.hbcPath === undefined) throw new ReadabilitySurfaceError("classify_module: ctx.hbcPath is required");
  const analysis = await loadAnalysis(ctx, ctx.hbcPath);
  const service = new NameService(analysis, new OverlayStore());
  const source = service.render().code;
  const res = await ctx.backend.run({ kind: "name-module", prompt: "", context: { module: args.module, source } });
  const parsed = parseReadabilityResult(res.text);
  if (!parsed.ok || parsed.result.abstained || parsed.result.names.length === 0) {
    return { confidence: "low", evidence: parsed.ok ? "" : parsed.error };
  }
  const top = parsed.result.names[0]!;
  const evaluation = await maybeEvaluate(ctx, args.evaluate, [
    { targetId: `module:${String(args.module)}`, proposedName: top.name, confidence: top.confidence, evidence: top.evidence },
  ]);
  return { role: inferModuleRole(`${top.name} ${top.evidence}`), path: top.name, confidence: top.confidence, evidence: top.evidence, evaluation };
}

// ---------------------------------------------------------------------------
// rewrite_function
// ---------------------------------------------------------------------------

export interface RewriteFunctionArgs {
  readonly fn: number;
  readonly budgetTokens?: number;
  readonly evaluate?: EvaluationMode;
}

export interface RewriteFunctionResult {
  readonly rewrite?: RewriteProposal;
  readonly equiv: EquivProof;
  readonly accepted: boolean;
  readonly txId?: string;
  readonly evaluation?: EvaluationReport | undefined;
}

const NO_PROPOSAL_PROOF: EquivProof = { scope: "function", verdict: "INCONCLUSIVE", oracle: "no rewrite proposed", coverage: { inputs: 0, records: 0 }, ts: new Date(0).toISOString() };

/** Section 9.7's `rewrite_function`: candidate -> `gateRewrite` -> (on
 *  ACCEPTED) `recordTransaction`. A caller-supplied candidate goes through
 *  the identical gate a model's own output does (the file header's "same
 *  gate" rule) because `gateRewrite` never distinguishes where `code` came
 *  from. */
export async function rewriteFunction(ctx: ReadabilityContext, args: RewriteFunctionArgs): Promise<RewriteFunctionResult> {
  if (ctx.hbcPath === undefined) throw new ReadabilitySurfaceError("rewrite_function: ctx.hbcPath is required");
  const analysis = await loadAnalysis(ctx, ctx.hbcPath);
  const service = new NameService(analysis, new OverlayStore());
  const faithfulCode = service.render().code;
  const res = await ctx.backend.run({ kind: "suggest-name", prompt: "", context: { fn: args.fn, source: faithfulCode } });
  const parsed = parseReadabilityResult(res.text);
  const proposal = parsed.ok ? parsed.result.rewrite : undefined;
  if (proposal === undefined) {
    return { equiv: NO_PROPOSAL_PROOF, accepted: false, evaluation: undefined };
  }
  const attempt = await gateRewrite(proposal, {
    faithfulCode,
    hbcPath: ctx.hbcPath,
    who: ctx.who ?? "worker:haiku",
    ...(ctx.functionOracle !== undefined ? { oracle: ctx.functionOracle } : {}),
  });
  if (!attempt.accepted || attempt.proof === undefined || attempt.record === undefined) {
    return { rewrite: proposal, equiv: attempt.proof ?? NO_PROPOSAL_PROOF, accepted: false, evaluation: undefined };
  }
  const tx: ReadabilityTransaction = rewriteRecordToTransaction(attempt.record);
  const priorContents = new Map(tx.prior.files.map((f) => [f.path, faithfulCode]));
  const { id } = recordTransaction(ctx.db, ctx.projectDir, tx, { priorContents });
  // Keep `treeDir` in sync with what the log now says, the same way
  // `runFileOp` does: the transaction's own `prior` is only reversible if a
  // later revert can read CURRENT bytes back off disk (spec 28 section 9.5's
  // `revert-of-a-revert` case), which means the accepted output has to
  // actually land on the tree, not just in the DB.
  for (const output of tx.outputs) {
    const abs = join(ctx.treeDir, output.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, attempt.code, "utf8");
  }
  const evaluation = await maybeEvaluate(ctx, args.evaluate, [
    { targetId: `fn:${String(args.fn)}`, proposedName: proposal.code.slice(0, 80), confidence: proposal.confidence, evidence: proposal.evidence },
  ]);
  return { rewrite: proposal, equiv: attempt.proof, accepted: true, txId: id, evaluation };
}

// ---------------------------------------------------------------------------
// file_op
// ---------------------------------------------------------------------------

export interface FileOpResult {
  readonly txId?: string;
  readonly equiv: EquivProof;
  readonly accepted: boolean;
}

/** Section 9.7's `file_op`: a thin pass-through to `runFileOp` (which already
 *  validates the tree-level equiv gate and commits the transaction) --
 *  argument validation is `runFileOp`'s own (an unknown `op` is a TypeScript
 *  compile error for a caller in this repo; an external MCP caller's JSON is
 *  validated by `src/mcp/tools.ts`'s schema, section 9.7). */
export function fileOp(ctx: ReadabilityContext, req: FileOpRequest): FileOpResult {
  const attempt = runFileOp(req, {
    db: ctx.db,
    projectDir: ctx.projectDir,
    treeDir: ctx.treeDir,
    who: ctx.who ?? "worker:haiku",
    ...(ctx.hbcPath !== undefined ? { hbcPath: ctx.hbcPath } : {}),
    ...(ctx.oracle !== undefined ? { oracle: ctx.oracle } : {}),
  });
  return { equiv: attempt.proof, accepted: attempt.accepted, ...(attempt.txId !== undefined ? { txId: attempt.txId } : {}) };
}

// ---------------------------------------------------------------------------
// promote_change / revert_change / list_suggestions
// ---------------------------------------------------------------------------

export interface PromoteChangeArgs {
  readonly txId?: string;
  readonly suggestionId?: string;
  readonly who: string;
}

export interface PromoteChangeResult {
  readonly txId: string;
  readonly tier: "confirmed";
}

/** Find the overlay record `rid` names, or `undefined` -- P-59: a
 *  `suggestionId` addresses a `NameRecord` (any record in its supersession
 *  chain, active or not; `active` is a rendering fact, not an identity one).
 */
function findOverlayRecord(ctx: ReadabilityContext, rid: string): NameRecord | undefined {
  return OverlayStore.load(overlayPathFor(ctx)).allRecords().find((r) => r.rid === rid);
}

/** Section 9.7's `promote_change` / section 1d "only a human or an opt-in
 *  evaluator promotes": refuses a `who` starting with `worker:` BEFORE
 *  touching either store (the same rule `validateTransaction`'s
 *  `self-promoted` code enforces on write; this is the read-side twin of
 *  it). `txId` promotes a rewrite/file-op transaction (`promoteTransaction`);
 *  `suggestionId` promotes a name (P-59): re-records the SAME name through
 *  `NameService.setName` -- the "existing set_name promoter path" -- under
 *  the promoter's own `who` as `source: "human"`, which supersedes the
 *  `source: "llm"` record in the overlay's own chain (spec 28 section 9.5's
 *  new paragraph). Refuses when neither id names a live change. */
export function promoteChange(ctx: ReadabilityContext, args: PromoteChangeArgs): PromoteChangeResult {
  if (args.who.startsWith("worker:")) {
    throw new TransactionRefused(`promote_change: ${args.who} may not write tier=confirmed (spec 28 section 1d)`, [
      { code: "self-promoted", detail: `${args.who} may not promote` },
    ]);
  }
  if (args.suggestionId !== undefined) {
    const overlayPath = overlayPathFor(ctx);
    const record = findOverlayRecord(ctx, args.suggestionId);
    if (record === undefined) {
      if (args.txId === undefined) throw new ReadabilitySurfaceError(`promote_change: no suggestion ${args.suggestionId}`);
    } else {
      if (ctx.hbcPath === undefined) throw new ReadabilitySurfaceError("promote_change: ctx.hbcPath is required to promote a name suggestion");
      const analysis = loadAnalysisSync(ctx, ctx.hbcPath);
      const store = OverlayStore.load(overlayPath);
      const service = new NameService(analysis, store);
      const outcome = service.setName(record.id, record.name, { confidence: record.confidence, evidence: record.evidence, source: "human" });
      if (!outcome.ok) throw new ReadabilitySurfaceError(`promote_change: gate refused: ${outcome.reason}`);
      store.save(overlayPath);
      return { txId: outcome.result.record.rid, tier: "confirmed" };
    }
  }
  const id = args.txId ?? args.suggestionId;
  if (id === undefined) throw new ReadabilitySurfaceError("promote_change: one of txId|suggestionId is required");
  return promoteTransaction(ctx.db, ctx.projectDir, id, args.who);
}

export interface RevertChangeArgs {
  readonly txId?: string;
  readonly suggestionId?: string;
}

export interface RevertChangeResult {
  readonly txId: string;
  readonly revertedTxId: string;
  readonly restored: readonly { readonly path: string; readonly sha256: string }[];
}

/** Section 9.7's `revert_change`: one-click undo (section 1d). `txId`
 *  reverts a rewrite/file-op transaction, byte-exact (section 9.5's
 *  reversibility guarantee). `suggestionId` reverts a name (P-59) through
 *  the overlay's OWN supersession (`OverlayStore.revert`): the binding's
 *  active record steps back to whatever was active before it (or clears, if
 *  none) -- a byte-identical render to the state before the promoted/llm
 *  write, proved by the same section 9.4 NAME-row backstop `suggest_names`
 *  runs. `restored` reports the binding as a synthetic `path` (there is no
 *  tree file for a name) plus a content hash of the name that is active
 *  after the revert, for parity with the file-tree shape other callers
 *  expect; it is empty when the revert clears to no active name. */
export function revertChange(ctx: ReadabilityContext, args: RevertChangeArgs): RevertChangeResult {
  if (args.suggestionId !== undefined) {
    const overlayPath = overlayPathFor(ctx);
    const record = findOverlayRecord(ctx, args.suggestionId);
    if (record !== undefined) {
      const store = OverlayStore.load(overlayPath);
      const restored = store.revert(record.id);
      store.save(overlayPath);
      return {
        txId: args.suggestionId,
        revertedTxId: record.rid,
        restored: restored !== null ? [{ path: `name:${bindingKey(record.id)}`, sha256: sha256(restored.name) }] : [],
      };
    }
    if (args.txId === undefined) throw new ReadabilitySurfaceError(`revert_change: no suggestion ${args.suggestionId}`);
  }
  if (args.txId === undefined) throw new ReadabilitySurfaceError("revert_change: one of txId|suggestionId is required");
  const result = revertTransaction(ctx.db, ctx.projectDir, ctx.treeDir, args.txId, ctx.who ?? "reviewer");
  return { txId: args.txId, revertedTxId: result.revertTxId, restored: result.restored };
}

export interface ListSuggestionsFilter {
  readonly tier?: "suggested" | "confirmed";
  readonly module?: number;
  /** Applies to name suggestions (`NameRecord.confidence`, P-59); a no-op
   *  over rewrite/file-op transactions (no confidence field there). */
  readonly confidence?: "low" | "med" | "high";
  readonly securityRelevant?: boolean;
}

export interface ListSuggestionsArgs {
  readonly filter?: ListSuggestionsFilter;
  readonly limit?: number;
}

/** A name proposal from the overlay (P-59), addressed by `suggestionId` (the
 *  overlay record's own `rid`) rather than a transaction id. */
export interface NameSuggestionItem {
  readonly kind: "name";
  readonly suggestionId: string;
  readonly bindingId: NameRecord["id"];
  readonly name: string;
  readonly confidence: "low" | "med" | "high";
  readonly evidence: string;
  readonly tier: "suggested" | "confirmed";
  readonly ts: string;
  /** See `NameRecord.securityRelevant`; absent when never flagged. */
  readonly securityRelevant?: boolean;
}

/** A rewrite/file-op transaction from the log, unchanged shape. */
export interface TxSuggestionItem {
  readonly kind: "tx";
  readonly tx: ReadabilityTransaction;
}

export type SuggestionItem = NameSuggestionItem | TxSuggestionItem;

export interface ListSuggestionsResult {
  readonly suggestions: readonly SuggestionItem[];
  readonly total: number;
}

/** `source: "llm"` is not yet reviewed (`tier: "suggested"`); anything a
 *  human (or an opt-in evaluator, 9.6) has since re-recorded through
 *  `promote_change` is `source: "human"`/`"heuristic"`, `tier: "confirmed"`
 *  -- the overlay-side twin of `ReadabilityTransaction.tier`. */
function overlayTier(record: NameRecord): "suggested" | "confirmed" {
  return record.source === "llm" ? "suggested" : "confirmed";
}

/** Section 9.7's `list_suggestions`, merged over BOTH sources (P-59): the
 *  overlay's active name records and the rewrite/file-op transaction log.
 *  `total` is the count AFTER filtering, BEFORE `limit` -- so a caller can
 *  page. */
export function listSuggestions(ctx: ReadabilityContext, args: ListSuggestionsArgs = {}): ListSuggestionsResult {
  const filter = args.filter;
  let items: SuggestionItem[] = [];

  let txRows = listTransactions(ctx.db).map((r) => r.tx);
  if (filter?.tier !== undefined) txRows = txRows.filter((tx) => tx.tier === filter.tier);
  if (filter?.module !== undefined) txRows = txRows.filter((tx) => tx.inputs.some((i) => i.module === filter.module));
  items.push(...txRows.map((tx): TxSuggestionItem => ({ kind: "tx", tx })));

  let names = OverlayStore.load(overlayPathFor(ctx)).allRecords().filter((r) => r.active);
  if (filter?.confidence !== undefined) names = names.filter((r) => r.confidence === filter.confidence);
  if (filter?.tier !== undefined) names = names.filter((r) => overlayTier(r) === filter.tier);
  // 2026-09-11 (docs/BUGS.md, resolved landing 4d): `NameRecord.securityRelevant`
  // now carries the ground truth `suggest_names`/`runNamePass` already had on
  // the target -- `false`/absent both read as "not flagged" here, matching
  // the boolean query-string filter (`qBool` in `readability-routes.ts`).
  if (filter?.securityRelevant !== undefined) names = names.filter((r) => (r.securityRelevant ?? false) === filter.securityRelevant);
  items.push(
    ...names.map((r): NameSuggestionItem => ({
      kind: "name",
      suggestionId: r.rid,
      bindingId: r.id,
      name: r.name,
      confidence: r.confidence,
      evidence: r.evidence,
      tier: overlayTier(r),
      ts: r.ts,
      ...(r.securityRelevant !== undefined ? { securityRelevant: r.securityRelevant } : {}),
    })),
  );

  const total = items.length;
  if (args.limit !== undefined) items = items.slice(0, args.limit);
  return { suggestions: items, total };
}

export { getTransaction };
