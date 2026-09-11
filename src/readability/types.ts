// src/readability/types.ts -- spec 28 (LLM readability layer) interface surface.
//
// This file is TYPES + small pure functions ONLY. The model-backed
// `HaikuBackend` is spec 28 landing 1 and lives in
// `src/workers/backends/haiku.ts`; nothing here opens a socket, spawns a
// process or reads an API key, and the gate never calls the network (spec 28
// section 9.1: tests drive a recorded/fake backend behind the same
// `WorkerBackend` interface). Keeping the contract here is what lets the
// acceptance tests (tests/gate/llm-readability/) ship before the
// implementation, the way spec 13 ships T1-T8 before its lanes.
import { createHash } from "node:crypto";
import type { JobKind } from "../workers/queue.ts";
import type { BindingId } from "../name-overlay/id.ts";
import type { Confidence } from "../name-overlay/store.ts";

// ---------------------------------------------------------------------------
// Skills (spec 28 section 2, section 9.2)
// ---------------------------------------------------------------------------

export const SKILL_IDS = ["hbc-name", "hbc-classify", "hbc-doc"] as const;
export type SkillId = (typeof SKILL_IDS)[number];

/** Shipped with landing 1. `hbc-doc` is DEFERRED (spec 28 section 8 default
 *  "after naming lands"), so it is a legal `SkillId` with no file on disk. */
export const SHIPPED_SKILL_IDS: readonly SkillId[] = ["hbc-name", "hbc-classify"];

/** Which skill a job kind loads. A kind absent from this map is not served by
 *  the readability layer and stays on the heuristic/other backends. */
export const SKILL_FOR_KIND: Readonly<Partial<Record<JobKind, SkillId>>> = {
  "suggest-name": "hbc-name",
  "name-module": "hbc-classify",
  "explain-fn": "hbc-doc",
  "doc-screen": "hbc-doc",
};

/** Repo-relative directory the skills live in (versioned, auditable). */
export const SKILLS_DIR = "skills";

// ---------------------------------------------------------------------------
// Backend configuration (spec 28 section 9.1)
// ---------------------------------------------------------------------------

export const DEFAULT_HAIKU_MODEL = "claude-haiku-4-5-20251001";
/** Env var holding the model id override. */
export const MODEL_ENV = "HBC2JS_LLM_MODEL";
/** Env var holding the per-run token budget. */
export const BUDGET_ENV = "HBC2JS_LLM_BUDGET_TOKENS";
/** Env var holding the cache directory override. */
export const CACHE_DIR_ENV = "HBC2JS_LLM_CACHE_DIR";
/** Env var the backend reads the credential FROM. The config records the NAME
 *  of the variable, never the value, so a config is safe to log. */
export const API_KEY_ENV = "ANTHROPIC_API_KEY";

export interface HaikuBackendConfig {
  /** Model id; `DEFAULT_HAIKU_MODEL` unless config/env overrides it. */
  readonly model: string;
  /** Hard stop for one run, in TOKENS (the project's tokens-not-dollars
   *  convention). A run that would exceed it stops cleanly. */
  readonly budgetTokens: number;
  /** Content-hash cache root (spec 28 section 9.3). Derived, gitignored. */
  readonly cacheDir: string;
  /** Where skills are loaded from. */
  readonly skillsDir: string;
  /** Per-call output cap handed to the model. */
  readonly maxOutputTokens: number;
  /** Name of the env var the credential comes from; never the value. */
  readonly apiKeyEnv: string;
}

export const DEFAULT_BUDGET_TOKENS = 2000000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

export interface ConfigOverrides {
  readonly model?: string;
  readonly budgetTokens?: number;
  readonly cacheDir?: string;
  readonly skillsDir?: string;
  readonly maxOutputTokens?: number;
}

export class ReadabilityConfigError extends Error {}

/** Resolve config from explicit overrides, then env, then defaults. Pure:
 *  `env` is passed in, never read from `process.env` here, so a test is
 *  deterministic. Throws `ReadabilityConfigError` on an unusable value rather
 *  than silently shrinking a budget to zero. */
export function resolveHaikuConfig(
  env: Readonly<Record<string, string | undefined>> = {},
  overrides: ConfigOverrides = {},
  projectDir = ".",
): HaikuBackendConfig {
  const model = overrides.model ?? env[MODEL_ENV] ?? DEFAULT_HAIKU_MODEL;
  if (model.trim() === "") throw new ReadabilityConfigError(`${MODEL_ENV}: model id must not be empty`);

  const budgetTokens = overrides.budgetTokens ?? numberFromEnv(env[BUDGET_ENV], BUDGET_ENV) ?? DEFAULT_BUDGET_TOKENS;
  if (!Number.isInteger(budgetTokens) || budgetTokens <= 0) {
    throw new ReadabilityConfigError(
      `${BUDGET_ENV}: budget must be a positive whole number of tokens, got ${String(budgetTokens)}`,
    );
  }

  const maxOutputTokens = overrides.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new ReadabilityConfigError(`maxOutputTokens must be a positive whole number, got ${String(maxOutputTokens)}`);
  }
  if (maxOutputTokens > budgetTokens) {
    throw new ReadabilityConfigError(`maxOutputTokens (${maxOutputTokens}) exceeds the whole-run budget (${budgetTokens})`);
  }

  const cacheDir = overrides.cacheDir ?? env[CACHE_DIR_ENV] ?? `${projectDir}/cache/llm-readability`;
  const skillsDir = overrides.skillsDir ?? SKILLS_DIR;
  return { model, budgetTokens, cacheDir, skillsDir, maxOutputTokens, apiKeyEnv: API_KEY_ENV };
}

function numberFromEnv(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ReadabilityConfigError(`${name}: not a number: ${raw}`);
  return n;
}

// ---------------------------------------------------------------------------
// Cache keys (spec 28 section 9.3) -- a re-run must be >= 90% cheaper
// ---------------------------------------------------------------------------

export interface CacheKeyInput {
  readonly kind: JobKind;
  readonly skillId: SkillId;
  /** Bump a skill and every answer it produced is stale, by construction. */
  readonly skillVersion: number;
  readonly model: string;
  /** The rendered function/module body the job is about. */
  readonly body: string;
  /** The `get_context` payload, serialised canonically by the caller. */
  readonly context: string;
}

/** Stable, content-addressed cache key. Two requests that differ in ANY field
 *  differ in key; two byte-identical requests share one. Synchronous and
 *  dependency-free so it can be asserted in the gate. */
export function cacheKey(input: CacheKeyInput): string {
  const parts = [
    `kind=${input.kind}`,
    `skill=${input.skillId}@${String(input.skillVersion)}`,
    `model=${input.model}`,
    `bodyLen=${String(input.body.length)}`,
    `body=${input.body}`,
    `contextLen=${String(input.context.length)}`,
    `context=${input.context}`,
  ];
  return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// What a readability job returns (spec 28 section 9.1 wire contract)
// ---------------------------------------------------------------------------

export interface NameProposal {
  readonly bindingId: BindingId;
  readonly name: string;
  readonly confidence: Confidence;
  /** WHY: the literal/endpoint/call site that motivated it. An empty string is
   *  not evidence, and a proposal without evidence can never be `high`. */
  readonly evidence: string;
}

export interface RewriteProposal {
  /** Function index the rewrite replaces (function-level only, landing 2). */
  readonly fn: number;
  readonly code: string;
  readonly confidence: Confidence;
  readonly evidence: string;
}

export interface DocProposal {
  readonly target: BindingId;
  readonly text: string;
  readonly confidence: Confidence;
  readonly evidence: string;
}

export interface ReadabilityResult {
  readonly names: readonly NameProposal[];
  readonly rewrite?: RewriteProposal;
  readonly doc?: DocProposal;
  /** True when the model deliberately produced nothing (no signal, or the
   *  original is already clear). Abstention is a valid answer, not a failure. */
  readonly abstained: boolean;
}

export type ParseOutcome =
  | { readonly ok: true; readonly result: ReadabilityResult }
  | { readonly ok: false; readonly error: string };

/** Parse a backend's `WorkerJobResponse.text` into a `ReadabilityResult`.
 *  NEVER throws: a model can emit anything, and malformed output is a
 *  rejected candidate, not a crashed run. */
export function parseReadabilityResult(text: string): ParseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not JSON: ${(e as Error).message}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "top level must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const namesRaw = obj["names"] ?? [];
  if (!Array.isArray(namesRaw)) return { ok: false, error: "`names` must be an array" };
  const names: NameProposal[] = [];
  for (const [i, n] of namesRaw.entries()) {
    const parsed = parseNameProposal(n);
    if (parsed === undefined) {
      return { ok: false, error: `names[${String(i)}] is not a {bindingId,name,confidence,evidence} object` };
    }
    names.push(parsed);
  }
  const abstainedRaw = obj["abstained"];
  if (abstainedRaw !== undefined && typeof abstainedRaw !== "boolean") {
    return { ok: false, error: "`abstained` must be a boolean when present" };
  }
  // A rewrite (spec 28 landing 2) is optional and, like a name, a CANDIDATE:
  // parsing it here only says the model's JSON had the right shape. Whether it
  // survives is decided by `gateRewrite` and the equivalence oracle alone.
  const rewriteRaw = obj["rewrite"];
  let rewrite: RewriteProposal | undefined;
  if (rewriteRaw !== undefined && rewriteRaw !== null) {
    rewrite = parseRewriteProposal(rewriteRaw);
    if (rewrite === undefined) {
      return { ok: false, error: "`rewrite` is not a {fn,code,confidence,evidence} object" };
    }
  }
  const abstained = abstainedRaw ?? (names.length === 0 && rewrite === undefined);
  return { ok: true, result: { names, abstained, ...(rewrite !== undefined ? { rewrite } : {}) } };
}

function parseRewriteProposal(r: unknown): RewriteProposal | undefined {
  if (typeof r !== "object" || r === null || Array.isArray(r)) return undefined;
  const o = r as Record<string, unknown>;
  const fn = o["fn"];
  const code = o["code"];
  const confidence = o["confidence"];
  const evidence = o["evidence"];
  if (typeof fn !== "number" || !Number.isInteger(fn) || fn < 0) return undefined;
  if (typeof code !== "string" || code.trim() === "") return undefined;
  if (typeof confidence !== "string" || !CONFIDENCES.includes(confidence)) return undefined;
  if (typeof evidence !== "string") return undefined;
  const conf = (evidence.trim() === "" && confidence === "high" ? "low" : confidence) as Confidence;
  return { fn, code, confidence: conf, evidence };
}

const CONFIDENCES: readonly string[] = ["low", "med", "high"];

function parseNameProposal(n: unknown): NameProposal | undefined {
  if (typeof n !== "object" || n === null || Array.isArray(n)) return undefined;
  const o = n as Record<string, unknown>;
  const name = o["name"];
  const confidence = o["confidence"];
  const evidence = o["evidence"];
  const bindingId = o["bindingId"];
  if (typeof name !== "string" || name === "") return undefined;
  if (typeof confidence !== "string" || !CONFIDENCES.includes(confidence)) return undefined;
  if (typeof evidence !== "string") return undefined;
  if (typeof bindingId !== "object" || bindingId === null) return undefined;
  // Evidence-free proposals can never be `high` (spec 28 sections 1 and 4).
  const conf = (evidence.trim() === "" && confidence === "high" ? "low" : confidence) as Confidence;
  return { bindingId: bindingId as BindingId, name, confidence: conf, evidence };
}

// ---------------------------------------------------------------------------
// The equivalence gate (spec 28 section 0a, section 9.4)
// ---------------------------------------------------------------------------

export type EquivScope = "name" | "function" | "tree";
export type EquivVerdict = "PASS" | "DIVERGENT" | "INCONCLUSIVE";

export interface EquivProof {
  readonly scope: EquivScope;
  readonly verdict: EquivVerdict;
  /** The oracle invocation, verbatim, so a proof is reproducible by hand. */
  readonly oracle: string;
  /** What the proof spans: fuzzed inputs and traced records. */
  readonly coverage: { readonly inputs: number; readonly records: number };
  readonly ts: string;
}

/** Accept iff the oracle says PASS. INCONCLUSIVE is never PASS (the harness
 *  rule); a failed candidate is discarded and the faithful original stands. */
export function equivAccepts(proof: EquivProof): boolean {
  return proof.verdict === "PASS";
}

// ---------------------------------------------------------------------------
// File-tree operations + the DB transaction log (spec 28 section 1c, 9.5)
// ---------------------------------------------------------------------------

export const FILE_OP_KINDS = ["make", "rename", "move", "combine", "split"] as const;
export type FileOpKind = (typeof FILE_OP_KINDS)[number];

/** Where an emitted file's content came from in the bytecode. One per
 *  contributing module/binding: this is what makes traceability checkable. */
export interface BindingOrigin {
  readonly module: number;
  readonly binding?: BindingId;
}

export interface EmittedFile {
  readonly path: string;
  /** MUST be non-empty: a file with no origin is an ORPHAN and the whole
   *  transaction is invalid (spec 28 section 7 traceability target). */
  readonly origins: readonly BindingOrigin[];
}

export interface ReadabilityTransaction {
  /** Content hash of the immutable defining fields (spec 18 section 7). */
  readonly id: string;
  readonly op: FileOpKind;
  readonly who: string;
  readonly tier: "suggested" | "confirmed";
  readonly ts: string;
  readonly inputs: readonly BindingOrigin[];
  readonly outputs: readonly EmittedFile[];
  readonly equiv: EquivProof;
  readonly evidence: string;
  /** Everything needed to put the tree back exactly as it was. Empty for a
   *  `make` (there was nothing there); required for every other op. */
  readonly prior: { readonly files: readonly { readonly path: string; readonly sha256: string }[] };
}

export interface TransactionProblem {
  readonly code: "orphan-file" | "no-inputs" | "not-reversible" | "equiv-not-passed" | "self-promoted";
  readonly detail: string;
}

/** Structural validity of one log entry, independent of any DB. Every rule
 *  here is a spec-28 section 7 acceptance target restated as a predicate. */
export function validateTransaction(tx: ReadabilityTransaction): readonly TransactionProblem[] {
  const problems: TransactionProblem[] = [];
  if (tx.inputs.length === 0) problems.push({ code: "no-inputs", detail: `${tx.id}: no input binding origins` });
  for (const f of tx.outputs) {
    if (f.origins.length === 0) problems.push({ code: "orphan-file", detail: `${f.path} traces to no bytecode origin` });
  }
  if (tx.prior.files.length === 0 && tx.op !== "make") {
    problems.push({ code: "not-reversible", detail: `${tx.id}: ${tx.op} records no prior state` });
  }
  if (!equivAccepts(tx.equiv)) {
    problems.push({ code: "equiv-not-passed", detail: `${tx.id}: equiv verdict ${tx.equiv.verdict}` });
  }
  if (tx.tier === "confirmed" && tx.who.startsWith("worker:")) {
    problems.push({ code: "self-promoted", detail: `${tx.who} may not write tier=confirmed (spec 28 section 1)` });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Quality review: labelled samples + pluggable raters (spec 28 section 7, 9.6)
// ---------------------------------------------------------------------------

export const MODULE_ROLES = ["screen", "navigator", "store", "api-client", "component", "util"] as const;
export type ModuleRole = (typeof MODULE_ROLES)[number];

export const LABELLED_TARGET_KINDS = ["module", "function", "register"] as const;
export type LabelledTargetKind = (typeof LABELLED_TARGET_KINDS)[number];

/** One hand-labelled target. The label is the GROUND TRUTH name (from a
 *  sourcemap, published source, or a human read), not a judgement of one
 *  particular proposal -- so the same sample grades any backend. */
export interface LabelledTarget {
  readonly id: string;
  readonly kind: LabelledTargetKind;
  /** Sourcemap path the ground truth came from, e.g.
   *  `/packages/core/src/useNavigationBuilder.tsx`. Resolved to a module
   *  index at run time (landing 1) so the sample survives a rebuild. */
  readonly source: string;
  readonly referenceName: string;
  /** Other names a rater must accept as correct. */
  readonly alsoAccept: readonly string[];
  readonly role?: ModuleRole;
  readonly securityRelevant: boolean;
  readonly note: string;
}

export interface LabelledSample {
  readonly app: string;
  readonly bundle: string;
  readonly labelledBy: string;
  readonly labelSource: string;
  readonly ts: string;
  readonly targets: readonly LabelledTarget[];
}

export const RATER_VERDICTS = ["accurate", "inaccurate", "misleading"] as const;
export type RaterVerdictKind = (typeof RATER_VERDICTS)[number];

export interface RaterVerdict {
  readonly verdict: RaterVerdictKind;
  readonly rationale: string;
}

/** Pluggable (spec 28 section 9.6): the default is offline and deterministic;
 *  a human or a model rater implements the same two members. */
export interface QualityRater {
  readonly id: string;
  rate(target: LabelledTarget, proposedName: string): RaterVerdict;
}

/** Normalise for comparison: case-insensitive, separators dropped. Role words
 *  (`use`, `Screen`, `Router`) are deliberately KEPT -- they carry the meaning
 *  the quality target is about. */
export function normaliseName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

/** The default, offline rater: a proposal is accurate when it normalises to
 *  the reference (or an accepted alternative); a wrong name on a
 *  security-relevant target is `misleading` (the class spec 28 section 7
 *  requires zero of); otherwise it is merely inaccurate. */
export class ReferenceNameRater implements QualityRater {
  readonly id = "reference-name";
  rate(target: LabelledTarget, proposedName: string): RaterVerdict {
    const p = normaliseName(proposedName);
    const accepted = [target.referenceName, ...target.alsoAccept].map(normaliseName);
    if (accepted.includes(p)) return { verdict: "accurate", rationale: `matches ${target.referenceName}` };
    if (target.securityRelevant) {
      return {
        verdict: "misleading",
        rationale: `security-relevant target ${target.id}: ${proposedName} is not ${target.referenceName}`,
      };
    }
    return { verdict: "inaccurate", rationale: `${proposedName} is not ${target.referenceName}` };
  }
}

/** Share of `high`-confidence proposals a rater judged accurate. Returns
 *  `undefined` for an empty high-confidence set (no claim either way) rather
 *  than a vacuous 100%. */
export function highConfidenceAccuracy(
  rater: QualityRater,
  sample: LabelledSample,
  proposals: ReadonlyMap<string, { readonly name: string; readonly confidence: Confidence }>,
): { readonly rate: number; readonly n: number; readonly misleading: number } | undefined {
  let n = 0;
  let accurate = 0;
  let misleading = 0;
  for (const target of sample.targets) {
    const p = proposals.get(target.id);
    if (p === undefined || p.confidence !== "high") continue;
    n += 1;
    const v = rater.rate(target, p.name);
    if (v.verdict === "accurate") accurate += 1;
    if (v.verdict === "misleading") misleading += 1;
  }
  if (n === 0) return undefined;
  return { rate: accurate / n, n, misleading };
}

// ---------------------------------------------------------------------------
// Who judges quality (spec 28 section 1d.1, section 9.6)
// ---------------------------------------------------------------------------

export const CALL_SURFACES = ["ui", "mcp", "cli"] as const;
export type CallSurface = (typeof CALL_SURFACES)[number];

export const EVALUATION_MODES = ["human-ui", "agent", "inline-caller", "none"] as const;
export type EvaluationMode = (typeof EVALUATION_MODES)[number];

export interface EvaluationRequest {
  readonly surface: CallSurface;
  /** What an automated caller asked for; ignored on the `ui` surface, where a
   *  human is present and IS the reviewer (section 1d.1). */
  readonly requested?: EvaluationMode;
}

/** Default selection: a human is watching on `ui`, so never spawn an evaluator
 *  there; automated surfaces get whatever the caller wired, and `none` (raw
 *  suggested + equiv-verified results) when it wired nothing. */
export function evaluationModeFor(req: EvaluationRequest): EvaluationMode {
  if (req.surface === "ui") return "human-ui";
  return req.requested ?? "none";
}

export interface EvaluationItem {
  readonly targetId: string;
  readonly proposedName: string;
  readonly confidence: Confidence;
  readonly evidence: string;
}

export interface EvaluationReport {
  readonly evaluator: string;
  readonly mode: EvaluationMode;
  readonly verdicts: readonly (RaterVerdict & { readonly targetId: string })[];
}

/** Opt-in plug-in point: NOT hard-wired to any model (section 1d.1). An
 *  evaluator never promotes; it annotates, and a human or the configured
 *  promoter decides. */
export interface EvaluatorPlugin {
  readonly id: string;
  readonly mode: EvaluationMode;
  evaluate(items: readonly EvaluationItem[], signal?: AbortSignal): Promise<EvaluationReport>;
}

// ---------------------------------------------------------------------------
// Surfaces (spec 28 section 9.7) -- names the spec text and the code share
// ---------------------------------------------------------------------------

export const READABILITY_MCP_TOOLS = [
  "suggest_names",
  "rewrite_function",
  "classify_module",
  "file_op",
  "promote_change",
  "revert_change",
  "list_suggestions",
] as const;
export type ReadabilityMcpTool = (typeof READABILITY_MCP_TOOLS)[number];

export const READABILITY_CLI_VERBS = [
  "name llm-fill",
  "readability rewrite",
  "readability file-op",
  "readability review",
] as const;

export const READABILITY_UI_ACTIONS = [
  "suggest names for this module",
  "make this function readable",
  "combine these files",
  "review suggestions",
] as const;
