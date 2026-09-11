// src/readability/evaluate.ts -- spec 28 landing 5 (sections 1b step 8, 1d.1,
// 9.6): the pluggable, opt-in evaluation-loop host.
//
// Correctness is always the equivalence oracle and is never pluggable; this
// module is about QUALITY review only, and quality review is opt-in and not
// hard-wired to any model (section 1d.1). `runEvaluation` just hands a batch
// of items to whichever `EvaluatorPlugin` the caller wired and returns its
// report untouched: it never writes to a DB, never promotes anything (an
// `EvaluationReport` has no promotion field at all, D28-1), and never reads
// or changes a transaction's tier. An evaluator ANNOTATES; only a human or
// the configured promoter (spec 28 section 1d) decides what becomes
// canonical.
//
// This module imports NO transport (the same rule
// `tests/gate/llm-readability/interface-shape.test.ts` enforces for every
// file in this directory): `AgentEvaluatorConfig.backend` is a
// `WorkerBackend` the caller already built (`FakeBackend`/`ReplayBackend` in
// the gate, `HaikuBackend` — or any other model — in production), never
// constructed here.
import type { Confidence } from "../name-overlay/store.ts";
import type { WorkerBackend } from "../workers/backend.ts";
import { evaluationModeFor } from "./types.ts";
import type {
  EvaluationItem,
  EvaluationReport,
  EvaluatorPlugin,
  RaterVerdict,
  RaterVerdictKind,
} from "./types.ts";

/** Re-exported for convenience: section 9.6's mode-selection function lives
 *  in `types.ts` (it is a pure function every surface needs, including ones
 *  that never touch a plugin), this module is where a caller wires the
 *  plugin THAT mode picks. */
export { evaluationModeFor };

/** The plug-in host (section 1d.1's "built-in, opt-in harness component"):
 *  runs `plugin` over `items` and returns its report AS IS. Never touches the
 *  DB tier, never promotes -- a caller that wants to act on the report does
 *  so itself, through the ordinary `promote_change`/`revert_change` surface. */
export async function runEvaluation(
  items: readonly EvaluationItem[],
  plugin: EvaluatorPlugin,
  signal?: AbortSignal,
): Promise<EvaluationReport> {
  return plugin.evaluate(items, signal);
}

/** The `none` plugin (section 9.6's default for `mcp`/`cli`): no judgement at
 *  all, just the raw `suggested` + equiv-verified results for the caller to
 *  decide. Exported mostly so a caller can use it as an explicit no-op
 *  rather than special-casing "no plugin wired". */
export const NONE_PLUGIN: EvaluatorPlugin = {
  id: "none",
  mode: "none",
  async evaluate(): Promise<EvaluationReport> {
    return { evaluator: "none", mode: "none", verdicts: [] };
  },
};

/** The `inline-caller` plugin (section 1d.1: "the calling/main agent
 *  evaluates inline -- no extra spawn"). The host cannot itself judge
 *  anything on the caller's behalf, so it returns a `pending-caller`
 *  judgement per item -- a shape the caller is expected to replace with its
 *  own verdicts after grading the results itself. This is the "no extra
 *  spawn" leg: nothing here calls a backend. */
export function createInlineCallerPlugin(): EvaluatorPlugin {
  return {
    id: "inline-caller",
    mode: "inline-caller",
    async evaluate(items: readonly EvaluationItem[]): Promise<EvaluationReport> {
      return {
        evaluator: "inline-caller",
        mode: "inline-caller",
        verdicts: items.map((i) => ({
          targetId: i.targetId,
          verdict: "pending-caller",
          rationale: "the calling agent grades this result inline; hbc2js does not spawn an evaluator for it",
        })),
      };
    },
  };
}

const VALID_VERDICTS: readonly RaterVerdictKind[] = ["accurate", "inaccurate", "misleading", "pending-caller"];

/** Parse one evaluator/adversarial call's `WorkerJobResponse.text` into a
 *  `RaterVerdict`. NEVER throws (the same convention as
 *  `parseReadabilityResult`): a model can emit anything, and malformed
 *  output is a low-information verdict (`inaccurate`, never a fabricated
 *  `accurate`), not a crashed run. */
export function parseVerdictResponse(text: string): RaterVerdict {
  try {
    const raw = JSON.parse(text) as { readonly verdict?: unknown; readonly rationale?: unknown };
    const verdict = raw.verdict;
    const rationale = raw.rationale;
    if (typeof verdict === "string" && (VALID_VERDICTS as readonly string[]).includes(verdict) && typeof rationale === "string") {
      return { verdict: verdict as RaterVerdictKind, rationale };
    }
  } catch {
    // fall through to the rejected-candidate verdict below.
  }
  return { verdict: "inaccurate", rationale: `malformed evaluator output: ${text.slice(0, 200)}` };
}

export interface AgentEvaluatorConfig {
  readonly backend: WorkerBackend;
  /** Plugin id in the returned report; defaults to `"agent"`. Set this when
   *  wiring more than one agent evaluator (e.g. "Haiku grading Haiku" for
   *  bulk names vs. a stronger model for hard targets, section 1d.1) so a
   *  caller can tell which one produced a report. */
  readonly id?: string;
}

/** The "agent" plugin (section 1d.1's "separate evaluator agent spawned
 *  after the rewrite... model chosen per stakes"): any `WorkerBackend` at
 *  all, driven by the `evaluate` job kind + the `hbc-evaluate` skill (spec 28
 *  section 9.2's format, routed in `SKILL_FOR_KIND`). One call per item, in
 *  order -- the same "no new transport" rule as every other job kind, just a
 *  second call through the existing `WorkerBackend.run`. */
export function createAgentEvaluatorPlugin(config: AgentEvaluatorConfig): EvaluatorPlugin {
  const id = config.id ?? "agent";
  return {
    id,
    mode: "agent",
    async evaluate(items: readonly EvaluationItem[], signal?: AbortSignal): Promise<EvaluationReport> {
      const verdicts: (RaterVerdict & { readonly targetId: string })[] = [];
      for (const item of items) {
        const res = await config.backend.run(
          {
            kind: "evaluate",
            prompt: "",
            context: { targetId: item.targetId, proposedName: item.proposedName, confidence: item.confidence, evidence: item.evidence },
          },
          signal,
        );
        verdicts.push({ targetId: item.targetId, ...parseVerdictResponse(res.text) });
      }
      return { evaluator: id, mode: "agent", verdicts };
    },
  };
}

// ---------------------------------------------------------------------------
// The adversarial re-check (spec 28 section 1b step 8, section 4, section 7)
// ---------------------------------------------------------------------------

export interface AdversarialTarget {
  readonly targetId: string;
  readonly proposedName: string;
  readonly confidence: Confidence;
  readonly evidence: string;
  readonly securityRelevant: boolean;
  /** Approximate call-site/xref count; a caller that does not track reach
   *  simply never sets it, and the target then qualifies only on
   *  `securityRelevant`. */
  readonly reach?: number;
}

/** section 1b step 8: "security-relevant or high-reach". Reach above this
 *  many call sites, at `high` confidence, is treated as high-value even when
 *  nothing flagged it security-relevant. */
export const ADVERSARIAL_REACH_THRESHOLD = 20;

export function needsAdversarialRecheck(t: Pick<AdversarialTarget, "securityRelevant" | "confidence" | "reach">): boolean {
  if (t.securityRelevant) return true;
  return t.confidence === "high" && (t.reach ?? 0) > ADVERSARIAL_REACH_THRESHOLD;
}

export interface AdversarialVerdict {
  readonly targetId: string;
  readonly proposedName: string;
  readonly misleading: boolean;
  readonly rationale: string;
}

/** One more backend call per QUALIFYING target (`needsAdversarialRecheck`),
 *  with `skills/hbc-adversarial.md`'s "does this name misrepresent the code?"
 *  question -- no new transport, the same `WorkerBackend.run` every job kind
 *  already uses, just the `adversarial-recheck` kind. Targets that do not
 *  qualify are skipped, not charged a call. */
export async function runAdversarialRecheck(
  targets: readonly AdversarialTarget[],
  backend: WorkerBackend,
  signal?: AbortSignal,
): Promise<readonly AdversarialVerdict[]> {
  const out: AdversarialVerdict[] = [];
  for (const t of targets) {
    if (!needsAdversarialRecheck(t)) continue;
    const res = await backend.run(
      { kind: "adversarial-recheck", prompt: "", context: { targetId: t.targetId, proposedName: t.proposedName, evidence: t.evidence } },
      signal,
    );
    const verdict = parseVerdictResponse(res.text);
    out.push({ targetId: t.targetId, proposedName: t.proposedName, misleading: verdict.verdict === "misleading", rationale: verdict.rationale });
  }
  return out;
}

/** Apply the recheck's verdicts to a proposal map: a `misleading` verdict
 *  demotes the proposal to `low` confidence (section 4: "only `high` is a
 *  candidate for auto-promote; `low` stays suggested" -- this is what makes
 *  the demotion actually block promotion) and prefixes its evidence with a
 *  `[flagged: misleading]` marker so the misrepresentation is visible
 *  wherever that evidence is shown (the suggestion pane, `list_suggestions`).
 *  Section 1b step 8 asks for a transaction-level `flagged` mark; a NAME
 *  proposal has no transaction row yet to carry one (`docs/PUSHBACK.md`
 *  P-59), so the marker lives in the evidence text instead until that gap
 *  closes. Non-misleading verdicts and targets never rechecked pass through
 *  unchanged. */
export function applyAdversarialDemotion<T extends { readonly confidence: Confidence; readonly evidence: string }>(
  proposals: ReadonlyMap<string, T>,
  verdicts: readonly AdversarialVerdict[],
): Map<string, T> {
  const demoted = new Map(proposals);
  for (const v of verdicts) {
    if (!v.misleading) continue;
    const p = demoted.get(v.targetId);
    if (p === undefined) continue;
    demoted.set(v.targetId, { ...p, confidence: "low", evidence: `[flagged: misleading] ${v.rationale} (was: ${p.evidence})` });
  }
  return demoted;
}

/** The FLAGGED_EVIDENCE_PREFIX every demoted evidence string starts with --
 *  exported so a UI filter or a test can recognise a flagged suggestion
 *  without re-deriving the exact wording `applyAdversarialDemotion`/
 *  `name-pass.ts` produce. */
export const FLAGGED_EVIDENCE_PREFIX = "[flagged: misleading]";
