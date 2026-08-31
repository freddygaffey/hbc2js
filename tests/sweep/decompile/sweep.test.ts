// docs/specs/05-emitter.md §11 T2 (the equivalence gate — the real acceptance
// test), T6 (obfuscated variants) and T7 (real bundles). Sweep tier: minutes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { requireSweep } from "../../support/tiers.ts";
import { repoRoot } from "../../support/paths.ts";
import { decompile, nodeCheck } from "../../../src/decompile.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { parseForDecompile } from "../../../src/decompile.ts";
import { structure } from "../../../src/structure/index.ts";
import { runTier } from "../../../src/harness/tiers.ts";
import type { DecompilerFn } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";

const hbc2js: DecompilerFn = (input) => decompile(input.hbcBytes, { resolveV98Ambiguity: true, moduleName: input.fixtureName }).code;

/**
 * The oracle set for the M4 acceptance run.
 *
 * `roundtrip` is excluded on purpose: it reports a *function count mismatch* as
 * DIVERGENT, and a decompiler's output can never have the original's function
 * count — it adds the runtime-helper prelude and the module wrapper. Spec 05 T5
 * asks for the round-trip as "a per-function match percentage … a ratchet, not a
 * global score", which the count check pre-empts. `fuzz` is excluded for the
 * reason recorded in docs/STATUS.md: V8 builds a TypeError's text out of the
 * *original source identifier* (`log.push is not a function`), which a
 * register-named baseline cannot reproduce and which SPEC puts out of scope.
 */
const ORACLES = ["syntax", "trace"] as const;

// T2 (the gate-fixture equivalence run) MOVED to
// tests/gate/decompile/equivalence.test.ts — review M4-H1: it is the
// decompiler's acceptance test and belongs in the per-commit gate, not in a
// tier `npm test` never runs. Only T6/T7, which need the hardened variants and
// the multi-megabyte bundles, stay here.
//
// npm-test-gate-speed (2026-08-31): T2 itself now runs on every `npm test`,
// but only at the two representative versions (94, 99 — see that file's own
// comment). T2-full below re-runs the exact same fixture set at the full
// 84/94/96/98/99 matrix, so no version combination goes unchecked — it is
// just not on the per-commit critical path. (`tiers.ts`'s now-removed
// `KNOWN_HANGS` used to exclude two fixtures here — see its own comment for
// the fix.)

test("T2-full: every gate fixture is PASS under the real decompiler, at all five HBC versions", async (t) => {
  if (!requireSweep(t)) return;
  const report = await runTier({ tier: "gate", decompiler: hbc2js, oracles: [...ORACLES] });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS);
  assert.deepEqual(
    bad.map((r) => `${r.fixture.name}: ${r.oracles.map((o) => `${o.oracle}=${o.verdict}`).join(" ")}`),
    [],
  );
  assert.equal(report.summary.divergent, 0);
  assert.equal(report.summary.error, 0);
  assert.equal(report.summary.inconclusive, 0);
  assert.ok(report.summary.pass >= 495, `only ${report.summary.pass} checks ran (expected at least 495 across all five versions)`);
  console.log(`gate (real decompiler, full matrix): ${JSON.stringify(report.summary)}, ${report.skippedByDesign.length} skipped-by-design`);
});

test("T6: the obfuscated variants decompile and stay equivalent", async (t) => {
  if (!requireSweep(t)) return;
  const report = await runTier({ tier: "hardened", decompiler: hbc2js, oracles: [...ORACLES] });
  assert.equal(report.summary.error, 0);
  // Recorded, not zero: the four class fixtures' obfuscated builds are listed in
  // docs/STATUS.md's M4 section with their reason.
  assert.ok(report.summary.divergent <= 4, `${report.summary.divergent} DIVERGENT in the hardened tier`);
  assert.ok(report.summary.pass > 230, `only ${report.summary.pass} passed`);
});

test("T7: real React Native bundles decompile, verify and pass node --check", (t) => {
  if (!requireSweep(t)) return;
  const dir = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72");
  const names = ["index.android.hbc", "index.android.debug.hbc", "index.android.noopt.hbc", "index.android.noopt.debug.hbc"];
  let checked = 0;
  for (const name of names) {
    const path = join(dir, name);
    try {
      statSync(path);
    } catch {
      continue;
    }
    const bytes = new Uint8Array(readFileSync(path));
    const { module } = parseForDecompile(bytes, { resolveV98Ambiguity: true });
    const analysis = analyseModule(module, { strictEnv: false });
    let structured = 0;
    for (let i = 0; i < module.functions.length; i++) {
      structure(analysis.cfg(i), { verify: true });
      structured++;
    }
    assert.equal(structured, module.functions.length, `${name}: not every function structured`);
    assert.equal(analysis.envGraph.unresolved.length, 0, `${name}: unresolved (env, slot) pairs`);
    const r = decompile(bytes, { resolveV98Ambiguity: true, moduleName: name, analysis: { strictEnv: false } });
    assert.equal(nodeCheck(r.code).ok, true, `${name}: node --check failed`);
    checked++;
  }
  assert.ok(checked > 0, "no bundle was available to check");
});
