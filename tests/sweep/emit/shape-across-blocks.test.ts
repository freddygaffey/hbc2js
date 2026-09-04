// docs/BUGS.md 2026-08-31 — the bundle that actually exhibited the
// object-shape gap. react-navigation-example fn#8640 creates one object
// literal (`{inputRange, outputRange, extrapolate}`, shape 2038) before a
// `JmpTrueLong` and finishes initialising slot 1 in BOTH arms; the arm the
// emitter printed first clobbers r3 with a `LoadFromEnvironment`, so the
// emission-order shape map had nothing left for `PutOwnBySlotIdx r3, r6, 1` at
// offset 186 (0xba) in the other arm. That threw `E_EMIT_UNSUPPORTED`, which
// aborted the whole 15,551-function `--split` when the row was filed and (after
// per-function isolation landed, commit 09011d7) degraded to one throwing stub.
// `src/emit/shapes.ts` resolves the shape over the CFG instead, so the read is
// answered from the dominating creation.
//
// INCONCLUSIVE-via-skip when the sweep tier isn't requested or the fixture's
// `.hbc` isn't present locally (run its `fetch.sh` first) — it is fetched, not
// committed, which is why this cannot be a gate test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { requireSweep } from "../../support/tiers.ts";
import { cachedDecompile } from "../../support/decompiled.ts";

const HBC = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.hbc");

void test("react-navigation-example-0.85.3: no function is stubbed for a missing object shape (fn#8640 offset 186)", (t) => {
  if (!requireSweep(t)) return;
  if (!existsSync(HBC)) {
    t.skip(`${HBC} not present — run this fixture's fetch.sh first (INCONCLUSIVE, not a failure)`);
    return;
  }
  const result = cachedDecompile(readFileSync(HBC), { moduleName: "react-navigation-example.hbc", strictEnv: false });
  assert.ok(result.code.length > 0, "the module emitted no code at all");

  // `W_FUNCTION_STUBBED`'s message carries the error code, not its text, so the
  // function index and offset are what identify this one (the reason text is
  // only in the stub body, asserted next).
  const stubbed8640 = result.diagnostics.filter((d) => d.code === "W_FUNCTION_STUBBED" && d.context?.functionIndex === 8640);
  assert.deepEqual(
    stubbed8640.map((d) => `${d.message} @${String(d.context?.offset)}`),
    [],
    "fn#8640 is a throwing stub again — the shape analysis in src/emit/shapes.ts is not seeing the NewObjectWithBuffer that dominates offset 186",
  );
  assert.equal(result.code.includes("has no known object shape"), false, "an isolated-failure stub for the shape gap is still being emitted somewhere in this bundle");

  // The property names the shape actually carries, so a future "resolve it
  // somehow" regression cannot pass by emitting a placeholder.
  assert.ok(result.code.includes("extrapolate"), "shape 2038's third key is missing from the output");
});
