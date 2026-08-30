// docs/specs/06-harness.md §7 — sweep and hardened tiers (D13, D16). Nightly
// cost; gated behind requireSweep so a bare `npm test` never runs this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTier, VERDICT } from "../../../src/harness/tiers.ts";
import { requireSweep } from "../../support/tiers.ts";

test("sweep tier: bundles round-trip + syntax only (D16 C3 — no source.js to trace against)", async (t) => {
  if (!requireSweep(t)) return;
  const report = await runTier({ tier: "sweep" });
  if (report.results.length === 0) {
    t.skip("no bundles found under tests/fixtures/bundles/** (fetch them per tests/fixtures/README.md)");
    return;
  }
  for (const r of report.results) {
    assert.ok(r.oracles.every((o) => o.oracle === "syntax" || o.oracle === "roundtrip"), `${r.fixture.name}: sweep must only run syntax/roundtrip, got ${JSON.stringify(r.oracles.map((o) => o.oracle))}`);
    // D16 C3: bundles have no hand-written source, and M4 (a real
    // decompiler) doesn't exist yet, so there is no candidate to check —
    // that is INCONCLUSIVE-by-construction under the identity stand-in, not
    // a failure. Once a real `decompiler` is plugged in (spec 06 §7's whole
    // point), this becomes a real PASS/DIVERGENT signal instead.
    assert.equal(r.verdict, VERDICT.INCONCLUSIVE, `${r.fixture.name}: expected INCONCLUSIVE under identityDecompiler (no source, no real decompiler yet), got ${r.verdict}`);
  }
  console.log(`sweep (identity stand-in, pre-M4): ${JSON.stringify(report.summary)}`);
});

test("sweep tier: a real decompiler plugged in DOES get checked (not INCONCLUSIVE) even with no source", async (t) => {
  if (!requireSweep(t)) return;
  const report = await runTier({ tier: "sweep", decompiler: (input) => `/* stand-in candidate for ${input.fixtureName} */\n1;\n` });
  if (report.results.length === 0) {
    t.skip("no bundles found under tests/fixtures/bundles/**");
    return;
  }
  for (const r of report.results) {
    assert.notEqual(r.verdict, VERDICT.INCONCLUSIVE, `${r.fixture.name}: a real (even trivial) decompiler should produce a real verdict, not the "no decompiler" INCONCLUSIVE`);
  }
});

test("hardened tier: obfuscated constructs must still PASS (D13's CFG-shape stressor)", async (t) => {
  if (!requireSweep(t)) return;
  const report = await runTier({ tier: "hardened", versions: [94] });
  if (report.results.length === 0) {
    t.skip("no .obf.hbc fixtures found (run tests/fixtures/build.sh --variants)");
    return;
  }
  const divergent = report.results.filter((r) => r.verdict === VERDICT.DIVERGENT);
  assert.equal(divergent.length, 0, `identity must not diverge on obfuscated variants: ${JSON.stringify(divergent.map((r) => r.fixture.name))}`);
  console.log(`hardened: ${JSON.stringify(report.summary)}`);
});

test("local-corpus tier: INCONCLUSIVE, never silently skipped-as-pass, when the (gitignored) corpus is absent", async (t) => {
  if (!requireSweep(t)) return;
  const report = await runTier({ tier: "local-corpus" });
  if (report.results.length === 1 && report.results[0]?.verdict === VERDICT.INCONCLUSIVE) {
    assert.equal(report.summary.inconclusive, 1);
    assert.equal(report.summary.pass, 0);
    return; // D16: absent corpus reports INCONCLUSIVE, exactly this shape.
  }
  // If a local corpus IS present, every result must at least have run
  // syntax + roundtrip (no trace/fuzz: no source available, D16 C5).
  for (const r of report.results) {
    assert.ok(r.oracles.every((o) => o.oracle === "syntax" || o.oracle === "roundtrip"));
  }
});
