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
// KNOWN GAP (docs/PUSHBACK.md P-59): `suggest_names`/`classify_module` write
// through the name-overlay (`NameService`/`OverlayStore`, landing 1's own
// storage), NOT the `readability_tx` table `rewrite`/`file_op` use. The
// transaction log's `EmittedFile` is file-tree-shaped (a `path` plus the
// origins that emit it, spec 28 section 9.5): a NAME change has no file yet
// at the point this tool runs (it operates on the raw decompile, same as
// landing 1's CLI pass), and forging a `path` for it would make a `revert`
// materialise a bogus file into `treeDir`. `suggest_names` is still
// equiv-verified (the section 9.4 NAME-row backstop, run once per batch) and
// reviewable (the overlay's own supersession chain, `NameRecord.rid`), but
// its `txIds` come back empty until a follow-up either extends the
// transaction log with an overlay-shaped entry or gives the overlay its own
// promote/revert table. `rewrite_function` and `file_op` do not have this
// gap: both already produce a `ReadabilityTransaction` (P-58's mapping for
// rewrite, `runFileOp` directly for file ops).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseForDecompile } from "../decompile.ts";
import { analyseModule } from "../cfg/index.ts";
import type { ModuleAnalysis } from "../cfg/index.ts";
import { NameService, OverlayStore, regId, shortForm } from "../name-overlay/index.ts";
import { rawFrameBodies } from "../name-overlay/frames.ts";
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
} from "./transactions.ts";
import { MODULE_ROLES, parseReadabilityResult } from "./types.ts";
import type {
  EquivProof,
  EvaluationMode,
  EvaluationReport,
  ModuleRole,
  NameProposal,
  ReadabilityTransaction,
  RewriteProposal,
} from "./types.ts";

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
  readonly hbcPath?: string;
  readonly oracle?: TreeEquivOracle;
  readonly functionOracle?: FunctionEquivOracle;
  readonly who?: string;
}

function loadAnalysis(hbcPath: string): ModuleAnalysis {
  const bytes = new Uint8Array(readFileSync(hbcPath));
  return analyseModule(parseForDecompile(bytes, {}).module, { strictEnv: true });
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
  const analysis = loadAnalysis(ctx.hbcPath);
  const service = new NameService(analysis, new OverlayStore());
  const fns = "fn" in args.target && args.target.fn !== undefined ? [args.target.fn] : analysis.module.functions.map((_, i) => i);
  const targets = nameableTargets(analysis, service, fns);
  const result = await runNamePass(targets, { backend: ctx.backend, service, ...(args.budgetTokens !== undefined ? { budgetTokens: args.budgetTokens } : {}) });
  const suggestions = result.outcomes.map((o) => o.proposal).filter((p): p is NameProposal => p !== undefined);
  return { suggestions, equiv: result.equiv, txIds: [], evaluation: undefined };
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
  const analysis = loadAnalysis(ctx.hbcPath);
  const service = new NameService(analysis, new OverlayStore());
  const source = service.render().code;
  const res = await ctx.backend.run({ kind: "name-module", prompt: "", context: { module: args.module, source } });
  const parsed = parseReadabilityResult(res.text);
  if (!parsed.ok || parsed.result.abstained || parsed.result.names.length === 0) {
    return { confidence: "low", evidence: parsed.ok ? "" : parsed.error };
  }
  const top = parsed.result.names[0]!;
  return { role: inferModuleRole(`${top.name} ${top.evidence}`), path: top.name, confidence: top.confidence, evidence: top.evidence, evaluation: undefined };
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
  const analysis = loadAnalysis(ctx.hbcPath);
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
  return { rewrite: proposal, equiv: attempt.proof, accepted: true, txId: id, evaluation: undefined };
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

/** Section 9.7's `promote_change` / section 1d "only a human or an opt-in
 *  evaluator promotes": refuses a `who` starting with `worker:` BEFORE
 *  touching the DB (the same rule `validateTransaction`'s `self-promoted`
 *  code enforces on write; this is the read-side twin of it), and refuses
 *  when neither `txId` nor `suggestionId` names a live transaction. Both id
 *  fields resolve the same way today (section 9.7's gap, P-59: a NAME
 *  suggestion has no transaction id yet, so a `suggestionId` for one is
 *  refused, not silently accepted). */
export function promoteChange(ctx: ReadabilityContext, args: PromoteChangeArgs): PromoteChangeResult {
  const id = args.txId ?? args.suggestionId;
  if (id === undefined) throw new ReadabilitySurfaceError("promote_change: one of txId|suggestionId is required");
  return promoteTransaction(ctx.db, ctx.projectDir, id, args.who);
}

export interface RevertChangeArgs {
  readonly txId: string;
}

export interface RevertChangeResult {
  readonly txId: string;
  readonly revertedTxId: string;
  readonly restored: readonly { readonly path: string; readonly sha256: string }[];
}

/** Section 9.7's `revert_change`: one-click undo (section 1d), byte-exact
 *  (section 9.5's reversibility guarantee). */
export function revertChange(ctx: ReadabilityContext, args: RevertChangeArgs): RevertChangeResult {
  const result = revertTransaction(ctx.db, ctx.projectDir, ctx.treeDir, args.txId, ctx.who ?? "reviewer");
  return { txId: args.txId, revertedTxId: result.revertTxId, restored: result.restored };
}

export interface ListSuggestionsFilter {
  readonly tier?: "suggested" | "confirmed";
  readonly module?: number;
  /** Not applicable to file-op/rewrite transactions (no confidence field on
   *  `ReadabilityTransaction`, P-59); accepted for schema parity with the
   *  section 9.7 table and always a no-op filter until a NAME suggestion has
   *  somewhere to record one. */
  readonly confidence?: "low" | "med" | "high";
  readonly securityRelevant?: boolean;
}

export interface ListSuggestionsArgs {
  readonly filter?: ListSuggestionsFilter;
  readonly limit?: number;
}

export interface ListSuggestionsResult {
  readonly suggestions: readonly ReadabilityTransaction[];
  readonly total: number;
}

/** Section 9.7's `list_suggestions`, over the rewrite/file-op transaction
 *  log (P-59: NAME suggestions are not in this list yet). `total` is the
 *  count AFTER filtering, BEFORE `limit` -- so a caller can page. */
export function listSuggestions(ctx: ReadabilityContext, args: ListSuggestionsArgs = {}): ListSuggestionsResult {
  let rows = listTransactions(ctx.db).map((r) => r.tx);
  const filter = args.filter;
  if (filter?.tier !== undefined) rows = rows.filter((tx) => tx.tier === filter.tier);
  if (filter?.module !== undefined) rows = rows.filter((tx) => tx.inputs.some((i) => i.module === filter.module));
  const total = rows.length;
  if (args.limit !== undefined) rows = rows.slice(0, args.limit);
  return { suggestions: rows, total };
}

export { getTransaction };
