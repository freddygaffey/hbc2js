// docs/specs/passes/03-global-access.md §7's corpus metric: the share of
// emitted functions free of a `" in "` global guard, and the `globalThis.`
// occurrence drop, over `tests/fixtures/constructs/**` at all five HBC
// versions, with `global-access` off vs on.
//
// Deviation from the spec's own stated targets (100% clean functions, >=60%
// `globalThis.` occurrence reduction; recorded here, in
// `docs/AGENT-LOG.md`, and in `tools/passes-metrics.mjs`'s own comment —
// mirroring `expr-rebuild-metrics.test.ts`'s precedent of measuring reality
// rather than restating an unreached target):
//
// 1. **`src/emit/scope-check.ts`'s EM-01 guard has no allowance for a bare
//    identifier a stage-B pass has proven sound** (`src/passes/global-access/
//    match.ts`'s block comment has the full account). Its `KNOWN_GLOBALS`
//    allowlist is deliberately narrow (ECMAScript intrinsics only), on the
//    standing assumption that a program-defined global is always read via
//    `globalThis.<name>` — the exact assumption R2 exists to break. Without
//    an emit-side fix (out of this rung's ownership: D12a keeps a pass out
//    of `src/emit`, and this rung must not touch it), `global-access` can
//    only safely fold a guard whose property name is already an ECMAScript
//    intrinsic (`Object`, `Array`, `Error`, `Symbol`, `Map`, `JSON`, …) —
//    never a real host global (`print`, the only guarded name in any of
//    this rung's own `targets` fixtures, none of which therefore fold at
//    all; see `global-access.test.ts`'s corpus loop and its comment). Most
//    of the shortfall below is this one gap.
// 2. `isProvenGlobal`'s own departure from §4's literal "exactly one write in
//    the whole function" (also documented in `match.ts`) recovers the
//    common "register reused for scratch once its globalThis role ends"
//    shape, but a register genuinely reused as `globalThis` a *second* time
//    is still refused (`unproven-global`, ambiguous) — this corpus does not
//    appear to hit that case, but it is a real, if narrow, residual gap.
//
// The floors below sit comfortably under the measured numbers, as a
// regression guard on what this rung actually achieves rather than a
// restatement of the unreached target.
import { test } from "node:test";
import assert from "node:assert/strict";
import { measureGlobalAccess } from "../../../tools/passes-metrics.mjs";

const CLEAN_FUNCTION_PCT_FLOOR = 55;
// `globalThis.` occurrences come overwhelmingly from the `DeclareGlobalVar`
// idiom (`if (!Object.prototype.hasOwnProperty.call(globalThis, "x")) {
// globalThis.x = undefined; }`) and the module wrapper's own
// `_fn0.call(globalThis)` — both explicitly out of this rung's scope (§7:
// "`DeclareGlobalVar` is out of scope"). A positive floor here would just be
// restating an unmeasured hope; asserting >=0 is the real regression guard
// (a negative value would mean occurrences *increased*, which would be a bug).
const GLOBALTHIS_REDUCTION_FLOOR_PCT = 0;

test("global-access corpus metric: clean-function share and globalThis. occurrence reduction stay above the measured floor", () => {
  const result = measureGlobalAccess();
  assert.ok(result.functionCount >= 900, `expected the corpus scan to cover most of tests/fixtures/constructs/** across all five versions, got ${result.functionCount} functions`);
  assert.ok(
    result.cleanFunctionPct >= CLEAN_FUNCTION_PCT_FLOOR,
    `clean-function share fell to ${result.cleanFunctionPct.toFixed(1)}% (floor ${CLEAN_FUNCTION_PCT_FLOOR}%): ${result.cleanFunctionPctBefore.toFixed(1)}% -> ${result.cleanFunctionPct.toFixed(1)}%`,
  );
  assert.ok(result.cleanFunctionPct > result.cleanFunctionPctBefore, `global-access should strictly increase the clean-function share (${result.cleanFunctionPctBefore.toFixed(1)}% -> ${result.cleanFunctionPct.toFixed(1)}%)`);
  assert.ok(
    result.globalThisOccurrences.reductionPct >= GLOBALTHIS_REDUCTION_FLOOR_PCT,
    `globalThis. occurrences regressed: ${result.globalThisOccurrences.before} -> ${result.globalThisOccurrences.after}`,
  );
});
