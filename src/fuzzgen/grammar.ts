// src/fuzzgen/grammar.ts — docs/specs/09-fuzzing.md §1.2.
//
// The construct-level fuzzer's JS subset. A production may be added here
// only when its docs/LOWERING-CATALOGUE.md row is confidence-✅ multi-version
// (spec §1.2's growth rule) — this file starts deliberately conservative:
// expressions (arithmetic/comparison/logical/ternary/template literals),
// control flow (if/else, for, while, switch, try/catch/finally), functions
// (incl. default params, closures), classes, generators, array/object
// literals, spread and destructuring. `grammarVersion` is bumped on every
// production change; every fuzz report records it (§1.2, §4.1).
export const GRAMMAR_VERSION = "0.1.0";

/** Tokens the generator/mutator must never emit — T2(d)'s allowlist scan
 *  checks generated output contains none of these (determinism + no
 *  IO/timers/nondeterminism per §1.2's "side-effect-bounded by construction"). */
export const BANNED_TOKENS: readonly string[] = ["Math.random", "Date", "setTimeout", "require", "import"];

/** True iff `src` contains no banned token. Used by the generator's own
 *  safety net and by T2(d). */
export function hasNoBannedTokens(src: string): boolean {
  return BANNED_TOKENS.every((tok) => !src.includes(tok));
}
