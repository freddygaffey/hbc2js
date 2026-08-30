// Trace comparison and verdict.
//
// The verdict is deliberately three-valued. A harness that only says
// pass/fail will report PASS for two programs that both crashed on line 1, or
// both timed out, or both did nothing observable — none of which is evidence
// of equivalence. Those cases are INCONCLUSIVE and must escalate to another
// oracle (fuzzing, round-trip recompilation, or a better fixture).

import { renderRecord, isComparable, isEvidence } from './trace.mjs';

export const VERDICT = {
  EQUIVALENT: 'EQUIVALENT',
  DIVERGENT: 'DIVERGENT',
  INCONCLUSIVE: 'INCONCLUSIVE',
};

export function compareTraces(a, b) {
  const ra = a.records.filter(isComparable);
  const rb = b.records.filter(isComparable);
  const la = ra.map(renderRecord);
  const lb = rb.map(renderRecord);

  let i = 0;
  const n = Math.min(la.length, lb.length);
  while (i < n && la[i] === lb[i]) i++;

  const divergence =
    i < n
      ? { index: i, a: la[i], b: lb[i] }
      : la.length !== lb.length
        ? {
            index: i,
            a: la[i] ?? '<end of trace>',
            b: lb[i] ?? '<end of trace>',
          }
        : null;

  const truncated = a.timedOut || b.timedOut || hasLimit(ra) || hasLimit(rb);
  const evidence = ra.filter(isEvidence).length;

  let verdict;
  let why;
  if (divergence) {
    // A divergence found *before* any truncation point is real regardless of
    // truncation: the two programs already disagreed.
    verdict = VERDICT.DIVERGENT;
    why = `traces diverge at record ${i}`;
  } else if (truncated) {
    verdict = VERDICT.INCONCLUSIVE;
    why = 'both traces hit a budget (timeout / record cap); the identical prefix proves nothing about the rest';
  } else if (evidence === 0) {
    verdict = VERDICT.INCONCLUSIVE;
    why = 'neither program produced observable behaviour: no output, no error, no globals, no return value';
  } else {
    verdict = VERDICT.EQUIVALENT;
    why = `${evidence} evidence records matched over ${la.length} trace records`;
  }

  return {
    verdict,
    why,
    evidence,
    records: la.length,
    divergence,
    context: divergence ? contextAround(la, lb, divergence.index) : null,
  };
}

function hasLimit(records) {
  return records.some((r) => r.k === 'limit');
}

function contextAround(la, lb, i, span = 3) {
  const lines = [];
  for (let j = Math.max(0, i - span); j < Math.min(Math.max(la.length, lb.length), i + span + 1); j++) {
    const A = la[j] ?? '<end>';
    const B = lb[j] ?? '<end>';
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
  return lines.join('\n');
}
