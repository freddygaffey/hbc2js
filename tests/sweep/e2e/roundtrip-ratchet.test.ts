// docs/TESTING.md "E2E tier 1" — corpus round-trip ratchet. Re-measures the
// committed bundles with tools/e2e/roundtrip-corpus.ts (split -> recompile
// per module with the bundle's own hermesc -> normalised per-function diff)
// and fails if any bundle's % IDENTICAL drops below the number recorded in
// docs/e2e/roundtrip-baseline.json. The ratchet may only go up: an
// improvement is reported, never asserted, so the baseline is bumped by hand
// (with the tool's numbers) when a change genuinely raises it.
//
// Sweep tier: two real bundles, one hermesc process per module — well over
// the gate's budget. Local-corpus bundles are measured by the tool and
// tabulated in docs/e2e/RESULTS.md, never gated (D16 C5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownBundles, PASS_MODES, runBundle } from "../../../tools/e2e/roundtrip-corpus.ts";
import { repoRoot } from "../../support/paths.ts";
import { requireSweep, timeScale } from "../../support/tiers.ts";

const BASELINE_PATH = join(repoRoot(), "docs", "e2e", "roundtrip-baseline.json");

export interface BaselineEntry {
  readonly functions: number;
  readonly identical: number;
  readonly identicalPct: number;
}

/** Keyed "<bundle>|<mode>", e.g. "rn-template-0.72|passes-on". */
export type Baseline = Record<string, BaselineEntry>;

function loadBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

/** The ratchet rule, factored out so the synthetic test below proves the
 *  assertion is load-bearing: a regression is any drop in % IDENTICAL. */
export function ratchetRegressed(before: BaselineEntry, now: { readonly identicalPct: number }): boolean {
  return now.identicalPct < before.identicalPct;
}

test(
  "E2E tier 1: % IDENTICAL per committed bundle never drops below docs/e2e/roundtrip-baseline.json",
  { timeout: 20 * 60_000 * timeScale() },
  async (t) => {
    if (!requireSweep(t)) return;
    const baseline = loadBaseline();
    const outDir = mkdtempSync(join(tmpdir(), "hbc2js-e2e-ratchet-"));
    const regressions: string[] = [];
    const improvements: string[] = [];
    let checked = 0;
    try {
      for (const spec of knownBundles().filter((b) => b.committed)) {
        if (!existsSync(spec.path)) {
          t.diagnostic(`${spec.name}: bundle not present (${spec.path}; see its fetch.sh) — not checked`);
          continue;
        }
        for (const mode of PASS_MODES) {
          const key = `${spec.name}|${mode}`;
          const before = baseline[key];
          if (before === undefined) continue; // never baselined: nothing to ratchet against
          let now;
          try {
            now = await runBundle(spec, { mode, outDir, log: () => {} });
          } catch (e) {
            if (e instanceof Error && e.message.startsWith("no hermesc for")) {
              t.diagnostic(`${key}: ${e.message} — not checked`);
              continue;
            }
            throw e;
          }
          checked++;
          const line = `${key}: ${before.identicalPct}% (${before.identical}/${before.functions}) -> ${now.identicalPct}% (${now.identical}/${now.functions})`;
          if (ratchetRegressed(before, now)) regressions.push(line);
          else if (now.identicalPct > before.identicalPct) improvements.push(line);
        }
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
    assert.ok(checked > 0, "no baseline entry could be re-measured — is a committed bundle present and tools/hermesc/** populated (tools/get-hermesc.sh all)?");
    assert.deepEqual(regressions, [], `E2E tier 1 round-trip ratchet regressed:\n  ${regressions.join("\n  ")}`);
    if (improvements.length > 0) {
      console.log(`E2E tier 1: ratchet can move up — re-run tools/e2e/roundtrip-corpus.ts and bump docs/e2e/roundtrip-baseline.json:\n  ${improvements.join("\n  ")}`);
    }
  },
);

test("the ratchet rule is load-bearing: a synthetic drop is a regression, a rise is not", () => {
  const before: BaselineEntry = { functions: 100, identical: 37, identicalPct: 37 };
  assert.equal(ratchetRegressed(before, { identicalPct: 36.99 }), true);
  assert.equal(ratchetRegressed(before, { identicalPct: 37 }), false);
  assert.equal(ratchetRegressed(before, { identicalPct: 37.01 }), false);
});

test("docs/e2e/roundtrip-baseline.json is well-formed and covers rn-template in both modes", () => {
  const baseline = loadBaseline();
  for (const mode of PASS_MODES) {
    const e = baseline[`rn-template-0.72|${mode}`];
    assert.ok(e !== undefined, `missing rn-template-0.72|${mode}`);
    assert.ok(e.functions > 0 && e.identical >= 0 && e.identical <= e.functions);
    assert.equal(e.identicalPct, Math.round((e.identical / e.functions) * 10000) / 100, `identicalPct must equal identical/functions to 2 dp for ${mode}`);
  }
  for (const key of Object.keys(baseline)) {
    if (key === "normalisation") continue; // meta field: src/harness/roundtrip.ts normalisation revision the numbers were measured under
    const [bundle, mode] = key.split("|");
    assert.ok(knownBundles().some((b) => b.name === bundle && b.committed), `${key}: only committed bundles belong in the baseline`);
    assert.ok(PASS_MODES.includes(mode as (typeof PASS_MODES)[number]), `${key}: unknown mode`);
  }
});

test("docs/e2e/roundtrip-baseline.json records which round-trip normalisation the numbers were measured under", () => {
  const baseline = loadBaseline();
  assert.equal(typeof (baseline as unknown as { normalisation?: unknown }).normalisation, "number", "docs/e2e/roundtrip-baseline.json must have a numeric \"normalisation\" field");
});
