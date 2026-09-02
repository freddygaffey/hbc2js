// docs/DECISIONS.md D22a — adversarial fixture tier: reported, never gating.
//
// This file decompiles every tests/fixtures/adversarial/<NN-name>/ fixture
// with the real decompiler and runs the harness's own oracle ladder against
// it (syntax + trace, Hermes VM as the D14/D15 reference wherever one
// exists for the fixture's version). It REPORTS a verdict per fixture and
// per version, but per D22a a DIVERGENT/ERROR here is a *found bug*
// (tracked in docs/BUGS.md), not a test failure: this file must never
// assert on a fixture's verdict content. That is what keeps it out of
// `npm test`'s gate twice over — once by location (`tests/gate/**/*.test.ts`
// is the gate glob; this lives under `tests/sweep/`) and once by
// construction (even under `npm run test:sweep`, a real, still-open bug
// here does not fail the run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runTier, hbc2jsDecompiler, VERDICT } from "../../../src/harness/tiers.ts";
import { requireSweep } from "../../support/tiers.ts";
import { repoRoot } from "../../support/paths.ts";

test("adversarial tier (D22a): decompile + Hermes-VM-referenced trace check, reported per fixture, never gating", async (t) => {
  if (!requireSweep(t)) return;

  const report = await runTier({ tier: "adversarial", decompiler: hbc2jsDecompiler });

  if (report.results.length === 0) {
    t.skip("no fixtures found under tests/fixtures/adversarial/** (see tests/fixtures/adversarial/README.md)");
    return;
  }

  // Structural sanity only — never a verdict-content assertion. The oracle
  // set this tier runs must be exactly syntax + trace (no fuzz/roundtrip:
  // D22a fixtures are single hand-written programs, not export-bearing
  // modules meant for a round-trip ratchet).
  for (const r of report.results) {
    assert.ok(
      r.oracles.every((o) => o.oracle === "syntax" || o.oracle === "trace"),
      `${r.fixture.name}: adversarial tier must only run syntax/trace oracles, got ${JSON.stringify(r.oracles.map((o) => o.oracle))}`,
    );
    // Every result produced a genuine, four-valued verdict — i.e. the ladder
    // actually ran, rather than silently no-op'ing.
    assert.ok([VERDICT.PASS, VERDICT.DIVERGENT, VERDICT.INCONCLUSIVE, VERDICT.ERROR].includes(r.verdict), `${r.fixture.name}: unexpected verdict ${String(r.verdict)}`);
  }

  // Report a one-line-per-(fixture,version) table. Console output only —
  // deliberately no assertion tied to verdict content (see file header).
  const lines: string[] = [`adversarial (D22a): ${JSON.stringify(report.summary)} — reported, non-gating (see docs/BUGS.md for open findings)`];
  for (const r of [...report.results].sort((a, b) => a.fixture.name.localeCompare(b.fixture.name))) {
    if (r.verdict === VERDICT.PASS && r.caveats.length === 0) continue; // quiet on the boring case
    const caveatNote = r.caveats.length > 0 ? " [D14 known-divergence caveat]" : "";
    const badOracles = r.oracles
      .filter((o) => o.verdict !== VERDICT.PASS)
      .map((o) => `${o.oracle}=${o.verdict}${o.detail !== undefined ? ` (${o.detail})` : ""}`)
      .join("; ");
    lines.push(`  ${r.verdict.padEnd(12)} ${r.fixture.name}${caveatNote}${badOracles.length > 0 ? ` — ${badOracles}` : ""}`);
  }
  console.log(lines.join("\n"));
});

test("gate tier never decompiles tests/fixtures/adversarial/** for pass/fail (D22a fixtures are reported-only, not gating)", () => {
  // The real D22a invariant is narrower than "no gate file may mention the
  // path": it is that no gate test feeds an adversarial fixture through the
  // real hbc2js decompiler and asserts pass/fail on the result (that is
  // exactly what this file's own first test does, deliberately, under
  // tests/sweep/ instead). A gate file is allowed to *talk about* the
  // fixtures dir — e.g. to explain why it is testing something else instead
  // (tests/gate/passes/adversarial-ladder.test.ts, which stresses the M5
  // pass ladder's own synthetic CFGs, not this corpus) or to check the
  // fixtures' *data* without ever decompiling it (tests/gate/harness/
  // adversarial-expected.test.ts, which re-derives expected.txt by running
  // each fixture's source.js as a plain Node script — no hbc2js decompiler
  // involved at all).
  //
  // So: flag any gate file that references the adversarial fixtures dir
  // AND imports something capable of running the decompiler (the harness's
  // tier runner or its decompiler entry points). Any other reference is
  // fine by construction and is additionally allow-listed below by name,
  // with the reason recorded above, so a new offender can't hide behind an
  // unrelated import and a stale reviewer's shrug.
  const gateDir = join(repoRoot(), "tests", "gate");
  const adversarialFixturesDir = join(repoRoot(), "tests", "fixtures", "adversarial");
  assert.ok(statSync(gateDir).isDirectory());
  assert.ok(statSync(adversarialFixturesDir).isDirectory());
  assert.ok(!gateDir.startsWith(adversarialFixturesDir) && !adversarialFixturesDir.startsWith(gateDir));

  const KNOWN_NON_GATING = new Set([
    join(gateDir, "passes", "adversarial-ladder.test.ts"), // mentions the dir only in a comment, decompiles nothing from it
    join(gateDir, "harness", "adversarial-expected.test.ts"), // reads fixture files, but re-derives expected.txt via `node`, never via the decompiler
  ]);
  const DECOMPILER_IMPORT = /from ["'][^"']*harness\/tiers(?:\.ts)?["']|from ["'][^"']*decompile[^"']*["']/;

  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith(".test.ts")) {
        const src = readFileSync(p, "utf8");
        if (!src.includes("fixtures/adversarial")) continue;
        if (KNOWN_NON_GATING.has(p)) continue;
        if (DECOMPILER_IMPORT.test(src)) offenders.push(p);
      }
    }
  };
  walk(gateDir);
  assert.deepEqual(offenders, [], `gate test file(s) decompile tests/fixtures/adversarial for pass/fail: ${offenders.join(", ")}`);

  // Belt-and-suspenders on the allow-list itself: confirm neither known-good
  // file actually imports the decompiler machinery, so the allow-list can
  // never quietly start hiding a real gating use.
  for (const p of KNOWN_NON_GATING) {
    assert.ok(statSync(p).isFile(), `allow-listed file missing: ${p}`);
    assert.ok(!DECOMPILER_IMPORT.test(readFileSync(p, "utf8")), `${p} is allow-listed as non-gating but imports the decompiler — narrow the allow-list or fix the file`);
  }
});
