// src/fuzzgen/signature.ts — docs/specs/09-fuzzing.md §1.4 step 1.
//
// Dedupes many failing programs down to one signature per underlying bug:
// verdict + first-differing-trace-record kind + a small normalised context
// (opcode/helper name, stripped of program-specific values).
import type { CheckResult } from "../harness/ladder.ts";

export interface DivergenceSignature {
  readonly verdict: string;
  readonly oracle: string;
  readonly recordKind: string;
  readonly context: string;
}

/** Strips digits/quoted literals from a divergence context string so two
 *  divergences that differ only in the specific value involved (not the
 *  underlying shape) dedupe to the same signature. */
function normaliseContext(s: string): string {
  return s
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/-?\d+(\.\d+)?/g, "#")
    .trim();
}

/** Computes a `DivergenceSignature` for a non-PASS `CheckResult`, or `null`
 *  for a PASS (nothing to signature). INCONCLUSIVE is included — a fuzzer
 *  run that produces many INCONCLUSIVE results is itself worth deduping and
 *  triaging, even though it never counts as a divergence for §1.5's rate. */
export function signatureOf(result: CheckResult): DivergenceSignature | null {
  if (result.verdict === "PASS") return null;
  const failing = result.oracles.find((o) => o.verdict === result.verdict) ?? result.oracles[result.oracles.length - 1];
  const recordKind = failing?.divergence?.context ?? failing?.oracle ?? "unknown";
  const rawContext = failing?.divergence !== undefined ? `${failing.divergence.a} | ${failing.divergence.b}` : (failing?.detail ?? "");
  return {
    verdict: result.verdict,
    oracle: failing?.oracle ?? "unknown",
    recordKind,
    context: normaliseContext(rawContext),
  };
}

/** Stable string key for a signature — dedup map key, and what lands in a
 *  `docs/BUGS.md` row / report `signatures` list. */
export function signatureKey(sig: DivergenceSignature): string {
  return `${sig.verdict}:${sig.oracle}:${sig.recordKind}:${sig.context}`;
}
