// docs/specs/06-harness.md §1 — port of tools/equiv/src/compare.mjs, typed
// verdicts. Trace comparison and verdict.
//
// The verdict is deliberately three-valued. A harness that only says
// pass/fail would report PASS for two programs that both crashed on line 1,
// or both timed out, or both did nothing observable — none of which is
// evidence of equivalence. Those cases are INCONCLUSIVE and must escalate to
// another oracle (fuzzing, round-trip recompilation, or a better fixture).
//
// docs/EQUIVALENCE.md R3 names the exact failure mode this guards against:
// two truncated traces with equal prefixes compare equal. **Never allow a
// two-valued verdict** — HA-01.
import type { Trace, TraceRecord } from "./trace.ts";
import { renderRecord, renderRecordMasked, isComparable, isEvidence, isResourceCeilingRecord, normaliseEngineMessages } from "./trace.ts";

export const TRACE_VERDICT = {
  EQUIVALENT: "EQUIVALENT",
  DIVERGENT: "DIVERGENT",
  INCONCLUSIVE: "INCONCLUSIVE",
} as const;
export type TraceVerdict = (typeof TRACE_VERDICT)[keyof typeof TRACE_VERDICT];

export interface TraceDivergence {
  readonly index: number;
  readonly a: string;
  readonly b: string;
}

export interface TraceComparison {
  readonly verdict: TraceVerdict;
  readonly why: string;
  readonly evidence: number;
  readonly records: number;
  readonly divergence: TraceDivergence | null;
  readonly context: string | null;
  /** Records (rendered, one string each) that only matched after
   *  `renderRecordMasked`'s identifier-token masking — never after plain
   *  `renderRecord`. Non-empty means this comparison is not an exact match;
   *  a caller (`ladder.ts`) must surface it as a distinct caveat, never
   *  fold it into a silent EQUIVALENT (docs/BUGS.md 2026-09-02, oracle
   *  message-text masking). */
  readonly maskedMatches: readonly string[];
}

interface ComparableTrace {
  readonly records: readonly TraceRecord[];
  readonly timedOut?: boolean;
}

export function compareTraces(a: ComparableTrace | Trace, b: ComparableTrace | Trace): TraceComparison {
  const ra = a.records.filter(isComparable);
  const rb = b.records.filter(isComparable);
  // Both sides are projected through the same engine-wording normalisation
  // (`normaliseEngineMessages`, docs/BUGS.md 2026-09-04 family F3) before
  // anything is compared: the missing-global ReferenceError text differs
  // between Hermes and V8 and reaches the trace inside ordinary `out`
  // records (`print(String(e))`), which the err/unhandled masking channel
  // never sees. Name-preserving, so a missing `f2` still never matches a
  // missing `f3`.
  const la = ra.map((r) => normaliseEngineMessages(renderRecord(r)));
  const lb = rb.map((r) => normaliseEngineMessages(renderRecord(r)));
  const laMasked = ra.map((r) => normaliseEngineMessages(renderRecordMasked(r)));
  const lbMasked = rb.map((r) => normaliseEngineMessages(renderRecordMasked(r)));

  // A record that differs only in an err/unhandled message's
  // identifier-shaped tokens (renderRecordMasked === renderRecord for every
  // other record kind, so this can never paper over a real divergence
  // elsewhere) advances the scan instead of ending it, but is recorded so
  // the caller must surface it, never silently drop it (see
  // `maskedMatches`'s doc).
  //
  // A `limit` record is not an observation, it is the marker that says "the
  // budget ran out here" (runner.ts pushes it on timeout / record cap), so
  // nothing at or after it on *either* side can be compared: the shorter
  // side's `limit` would otherwise line up against the longer side's next
  // real record and read as a divergence at the cut-off (docs/PUSHBACK.md
  // P-16). Comparison therefore stops at the earliest budget marker.
  let i = 0;
  const n = Math.min(la.length, lb.length);
  const limitAt = (records: readonly TraceRecord[]): number => {
    const idx = records.findIndex((r) => r.k === "limit");
    return idx < 0 ? Number.POSITIVE_INFINITY : idx;
  };
  const cutoff = Math.min(n, limitAt(ra), limitAt(rb));
  const maskedMatches: string[] = [];
  while (i < cutoff) {
    if (la[i] === lb[i]) {
      i++;
      continue;
    }
    if (laMasked[i] === lbMasked[i]) {
      maskedMatches.push(`record ${i}: "${la[i]}" vs "${lb[i]}" — identifier-masked match ("${laMasked[i]}")`);
      i++;
      continue;
    }
    break;
  }

  // Two distinct reasons the traces are not identical, and they are *not*
  // equally strong evidence (docs/BUGS.md 2026-09-04 family H1, PUSHBACK
  // P-16): a divergence found inside the common prefix means the two
  // programs really disagreed, whereas an equal prefix with unequal lengths
  // can be nothing but one side stopping earlier — which is exactly what a
  // budget (timeout / record cap) does to a non-terminating program. The
  // budget test must therefore be consulted *before* the length mismatch is
  // called a divergence, or the "both traces hit a budget" branch below is
  // unreachable whenever the two record counts differ (which, for a
  // non-terminating program, they always do).
  const lengthMismatch = la.length !== lb.length;

  const timedOutA = "timedOut" in a && a.timedOut === true;
  const timedOutB = "timedOut" in b && b.timedOut === true;
  const truncatedA = timedOutA || hasLimit(ra);
  const truncatedB = timedOutB || hasLimit(rb);
  const evidence = ra.filter(isEvidence).length;

  // Resource-ceiling marker (docs/BUGS.md 2026-09-04, the 30 post-P-16
  // survivors). One side died where the engine ran out of room — call
  // stack, max string length, max array length — while the other side was
  // still producing ordinary output and was itself cut off by a budget. The
  // engine's ceiling is a property of the *host*, not of the program: it is
  // the same kind of "we stopped looking here" marker a `limit` record is,
  // so the comparison ends at it, INCONCLUSIVE, exactly as it would at a
  // `limit`. Three guards keep this from swallowing real evidence:
  //   * the prefix up to that record must already be equal (we only get
  //     here at the first mismatch, so anything earlier is a real
  //     divergence and is reported as one);
  //   * exactly one side may be resource-ceiling shaped — if the other side
  //     terminated too, with any err/unhandled of its own, the two really
  //     did die differently and that stays DIVERGENT;
  //   * the other side must itself be budget-limited, i.e. still running
  //     when we stopped watching. A program that genuinely throws
  //     `RangeError: Invalid array length` (`new Array(-1)`) against a side
  //     that ran to completion is therefore still DIVERGENT.
  const stillRunning = (r: TraceRecord | undefined): boolean => r !== undefined && r.k !== "err" && r.k !== "unhandled";
  const aCeiling = i < cutoff && isResourceCeilingRecord(ra[i]!);
  const bCeiling = i < cutoff && isResourceCeilingRecord(rb[i]!);
  const resourceCeiling: "a" | "b" | null =
    aCeiling && !bCeiling && stillRunning(rb[i]) && truncatedB ? "a" : bCeiling && !aCeiling && stillRunning(ra[i]) && truncatedA ? "b" : null;
  const truncated = truncatedA || truncatedB || resourceCeiling !== null;

  const prefixDivergence: TraceDivergence | null = i < cutoff && resourceCeiling === null ? { index: i, a: la[i]!, b: lb[i]! } : null;

  // Budget-limited with an equal prefix: no divergence is reported at all,
  // so a timing-dependent cut-off point can never become a divergence
  // signature (`src/fuzzgen/signature.ts` keys off `divergence`).
  //
  // *Both* sides must have been cut off for a length mismatch to be
  // evidence-free. If one side ran to completion, its trace is total
  // information: "terminated after k records" versus "still going at k
  // records" is a real behaviour difference, and killing it would blind the
  // mutation selftest (`tests/gate/harness/selftest.test.ts` HA-09, whose
  // kill rate drops by 8 mutants under an either-side rule).
  const budgetLimited = prefixDivergence === null && (resourceCeiling !== null || (truncatedA && truncatedB));
  const divergence: TraceDivergence | null =
    prefixDivergence ?? (lengthMismatch && !budgetLimited ? { index: i, a: la[i] ?? "<end of trace>", b: lb[i] ?? "<end of trace>" } : null);

  let verdict: TraceVerdict;
  let why: string;
  if (divergence !== null) {
    // A divergence found *before* any truncation point is real regardless of
    // truncation: the two programs already disagreed. So is an unequal
    // length when *neither* side hit a budget — one program simply stopped.
    verdict = TRACE_VERDICT.DIVERGENT;
    why = prefixDivergence !== null ? `traces diverge at record ${i}` : `traces have equal prefixes but different lengths (${la.length} vs ${lb.length}) and neither hit a budget`;
  } else if (resourceCeiling !== null) {
    verdict = TRACE_VERDICT.INCONCLUSIVE;
    const which = resourceCeiling === "a" ? "first" : "second";
    const ceilingRecord = resourceCeiling === "a" ? la[i]! : lb[i]!;
    why = `resource: the ${which} trace hit an engine resource ceiling (${ceilingRecord}) after ${i} identical record(s) while the other side was still running inside its own budget; an engine limit is a budget marker, not an observation, so the rest was never observed`;
  } else if (truncated) {
    verdict = TRACE_VERDICT.INCONCLUSIVE;
    why = lengthMismatch
      ? `both traces hit a budget (timeout / record cap) and the traces have different lengths (${la.length} vs ${lb.length}); the identical ${cutoff}-record prefix proves nothing about the rest`
      : "both traces hit a budget (timeout / record cap); the identical prefix proves nothing about the rest";
  } else if (evidence === 0) {
    verdict = TRACE_VERDICT.INCONCLUSIVE;
    why = "neither program produced observable behaviour: no output, no error, no globals, no return value";
  } else {
    verdict = TRACE_VERDICT.EQUIVALENT;
    why = `${evidence} evidence records matched over ${la.length} trace records`;
  }

  return {
    verdict,
    why,
    evidence,
    records: la.length,
    divergence,
    context: divergence !== null ? contextAround(la, lb, divergence.index) : null,
    maskedMatches,
  };
}

function hasLimit(records: readonly TraceRecord[]): boolean {
  return records.some((r) => r.k === "limit");
}

function contextAround(la: readonly string[], lb: readonly string[], i: number, span = 3): string {
  const lines: string[] = [];
  for (let j = Math.max(0, i - span); j < Math.min(Math.max(la.length, lb.length), i + span + 1); j++) {
    const A = la[j] ?? "<end>";
    const B = lb[j] ?? "<end>";
    if (j === i) {
      lines.push(`  ${String(j).padStart(4)} - ${A}`);
      lines.push(`  ${String(j).padStart(4)} + ${B}`);
    } else if (A === B) {
      lines.push(`  ${String(j).padStart(4)}   ${A}`);
    } else {
      lines.push(`  ${String(j).padStart(4)} - ${A}`);
      lines.push(`  ${String(j).padStart(4)} + ${B}`);
    }
  }
  return lines.join("\n");
}
