// docs/QUEUE.md "A" OPEN-SOURCE APP GROUND-TRUTH BENCHMARK, docs/e2e/OSS-BENCHMARK.md:
// runs tools/e2e/oss-benchmark.mjs on react-navigation-example-0.85.3 (the
// one configured app with a committed source map) and ratchets two numbers
// against docs/e2e/oss-benchmark-baseline.json -- naming mean fuzzy
// similarity and classification (package-level) precision -- both may only
// go UP, per the brief. Everything else in the scorecard is reported via
// t.diagnostic, not asserted, since this benchmark's whole point is to
// surface real numbers, not to freeze every field.
//
// Sweep tier (spawns the pipeline on a 1782-module real bundle): skips
// gracefully, not a failure, when the bundle isn't present (matches
// tests/sweep/e2e/boot-split.test.ts's pattern).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { requireSweep, timeScale } from "../../support/tiers.ts";

const APP_NAME = "react-navigation-example-0.85.3";
const HBC = join(repoRoot(), "tests/fixtures/bundles/react-navigation-example-0.85.3/react-navigation-example.hbc");
const MAP = join(repoRoot(), "tests/fixtures/bundles/react-navigation-example-0.85.3/react-navigation-example.map");
const HARNESS = join(repoRoot(), "tools/e2e/oss-benchmark.mjs");
const BASELINE_PATH = join(repoRoot(), "docs/e2e/oss-benchmark-baseline.json");

interface Scorecard {
  readonly ok: boolean;
  readonly hasGroundTruth: boolean;
  readonly classification: { readonly libraryPackagePrecision: { readonly value: number | null } };
  readonly naming: { readonly meanFuzzySimilarity: number };
}

test(
  "E2E: OSS ground-truth benchmark on react-navigation-example doesn't regress below baseline",
  { timeout: 5 * 60_000 * timeScale() },
  (t) => {
    if (!requireSweep(t)) return;
    if (!existsSync(HBC) || !existsSync(MAP)) {
      t.diagnostic(`bundle or map not present (${HBC}) -- not checked`);
      return;
    }

    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Scorecard;

    const r = spawnSync(process.execPath, [HARNESS, "--app", APP_NAME, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `oss-benchmark.mjs failed: ${r.stderr}`);
    const result = JSON.parse(r.stdout) as Scorecard;

    assert.equal(result.ok, true);
    assert.equal(result.hasGroundTruth, true, "react-navigation-example-0.85.3 must have a scored ground truth (its .map is committed)");

    t.diagnostic(
      `naming mean fuzzy: ${result.naming.meanFuzzySimilarity.toFixed(3)} (baseline ${baseline.naming.meanFuzzySimilarity.toFixed(3)}); ` +
        `classification precision: ${result.classification.libraryPackagePrecision.value} (baseline ${baseline.classification.libraryPackagePrecision.value})`,
    );

    // Ratchets (per the brief): these two numbers may only improve.
    assert.ok(
      result.naming.meanFuzzySimilarity >= baseline.naming.meanFuzzySimilarity,
      `naming mean fuzzy similarity regressed: baseline ${baseline.naming.meanFuzzySimilarity}, got ${result.naming.meanFuzzySimilarity}`,
    );
    const basePrecision = baseline.classification.libraryPackagePrecision.value;
    const gotPrecision = result.classification.libraryPackagePrecision.value;
    if (basePrecision !== null) {
      assert.ok(
        gotPrecision !== null && gotPrecision >= basePrecision,
        `classification (package-level) precision regressed: baseline ${basePrecision}, got ${gotPrecision}`,
      );
    }
  },
);
