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
import { renderRecord, renderRecordMasked, isComparable, isEvidence } from "./trace.ts";

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
  const la = ra.map(renderRecord);
  const lb = rb.map(renderRecord);
  const laMasked = ra.map(renderRecordMasked);
  const lbMasked = rb.map(renderRecordMasked);

  // A record that differs only in an err/unhandled message's
  // identifier-shaped tokens (renderRecordMasked === renderRecord for every
  // other record kind, so this can never paper over a real divergence
  // elsewhere) advances the scan instead of ending it, but is recorded so
  // the caller must surface it, never silently drop it (see
  // `maskedMatches`'s doc).
  let i = 0;
  const n = Math.min(la.length, lb.length);
  const maskedMatches: string[] = [];
  while (i < n) {
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

  const divergence: TraceDivergence | null =
    i < n
      ? { index: i, a: la[i]!, b: lb[i]! }
      : la.length !== lb.length
        ? { index: i, a: la[i] ?? "<end of trace>", b: lb[i] ?? "<end of trace>" }
        : null;

  const timedOutA = "timedOut" in a && a.timedOut === true;
  const timedOutB = "timedOut" in b && b.timedOut === true;
  const truncated = timedOutA || timedOutB || hasLimit(ra) || hasLimit(rb);
  const evidence = ra.filter(isEvidence).length;

  let verdict: TraceVerdict;
  let why: string;
  if (divergence !== null) {
    // A divergence found *before* any truncation point is real regardless of
    // truncation: the two programs already disagreed.
    verdict = TRACE_VERDICT.DIVERGENT;
    why = `traces diverge at record ${i}`;
  } else if (truncated) {
    verdict = TRACE_VERDICT.INCONCLUSIVE;
    why = "both traces hit a budget (timeout / record cap); the identical prefix proves nothing about the rest";
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
