// docs/e2e/CORPUS-REGRESSION.md: catches LOCAL MAXIMA / overfitting across
// the whole proprietary local corpus (~/hbc2js-local-corpus/apks, never
// committed) -- a change that improves one app (e.g. NSW's screen-naming
// tuning) must not silently regress another (it did, on Brex/Uniswap: a
// one-off sweep that caught it is what this test formalises). Compares a
// fresh run of tools/e2e/corpus-regression.mjs against
// docs/e2e/corpus-baseline.json per app.
//
// Sweep tier, same skip pattern as tests/sweep/e2e/oss-benchmark.test.ts:
// - HBC2JS_TIER != sweep|all -> requireSweep(t) skips the whole file.
// - a baseline app whose bundle isn't present locally (the corpus is never
//   committed, so this is EVERY app on a bare CI checkout) -> that app is
//   skipped individually, never a failure. The file passes vacuously with
//   zero apps checked when the corpus dir doesn't exist at all -- still not
//   a failure, since "no corpus here" is expected almost everywhere this
//   runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { requireSweep, timeScale } from "../../support/tiers.ts";

const HARNESS = join(repoRoot(), "tools/e2e/corpus-regression.mjs");
const BASELINE_PATH = join(repoRoot(), "docs/e2e/corpus-baseline.json");
const CORPUS_DIR = process.env["HBC2JS_CORPUS_DIR"] ?? join(homedir(), "hbc2js-local-corpus", "apks");

interface AppMetrics {
  readonly app: string;
  readonly decompile: { readonly status: string; readonly errorCode?: string };
  readonly validJsPct?: number;
  readonly screens?: { readonly plausibilityRatio: number };
  readonly overfitFlags: readonly string[];
}

interface Sweep {
  readonly apps: readonly AppMetrics[];
}

test("E2E: corpus-wide regression sweep doesn't regress below baseline (per app)", { timeout: 10 * 60_000 * timeScale() }, (t) => {
  if (!requireSweep(t)) return;
  if (!existsSync(BASELINE_PATH)) {
    t.diagnostic(`no baseline at ${BASELINE_PATH} -- not checked`);
    return;
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Sweep;
  const baselineApps = baseline.apps.filter((a) => a.decompile.status === "ok");
  if (baselineApps.length === 0) {
    t.diagnostic("baseline has no apps with decompile.status === 'ok' -- nothing to compare");
    return;
  }

  const appNames = baselineApps.map((a) => a.app);
  const apkPresent = appNames.filter((name) => existsSync(join(CORPUS_DIR, `${name}.apk`)));
  if (apkPresent.length === 0) {
    t.diagnostic(`corpus not present at ${CORPUS_DIR} -- 0/${appNames.length} baseline apps checked`);
    return;
  }

  const r = spawnSync(process.execPath, [HARNESS, "--only", apkPresent.join(","), "--json", "--corpus-dir", CORPUS_DIR], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `corpus-regression.mjs failed: ${r.stderr}`);
  const sweep = JSON.parse(r.stdout) as Sweep;
  const byName = new Map(sweep.apps.map((a) => [a.app, a]));

  const regressions: string[] = [];
  let checked = 0;
  for (const base of baselineApps) {
    if (!apkPresent.includes(base.app)) continue;
    const got = byName.get(base.app);
    if (got === undefined) {
      regressions.push(`${base.app}: missing from sweep output`);
      continue;
    }
    checked++;

    // Hard-fail: correctness regressions (docs/e2e/CORPUS-REGRESSION.md).
    if (got.decompile.status !== "ok") {
      regressions.push(`${base.app}: was decompile.status "ok" at baseline, now "${got.decompile.status}" (${got.decompile.errorCode ?? ""})`);
      continue;
    }
    if (base.validJsPct !== undefined && got.validJsPct !== undefined && got.validJsPct < base.validJsPct) {
      regressions.push(`${base.app}: validJsPct dropped ${base.validJsPct.toFixed(1)} -> ${got.validJsPct.toFixed(1)}`);
    }
    if (base.screens !== undefined && got.screens !== undefined && got.screens.plausibilityRatio < base.screens.plausibilityRatio) {
      regressions.push(
        `${base.app}: screen plausibility dropped ${(base.screens.plausibilityRatio * 100).toFixed(0)}% -> ${(got.screens.plausibilityRatio * 100).toFixed(0)}% (likely new false-positive screen names -- the NSW/Brex/Uniswap failure mode)`,
      );
    }

    // Report-only: everything else is diagnostic, never asserted (this
    // baseline's job is to surface real numbers, not freeze every one).
    t.diagnostic(`${base.app}: overfitFlags=[${got.overfitFlags.join("; ")}]`);
  }

  t.diagnostic(`checked ${checked}/${appNames.length} baseline apps present in ${CORPUS_DIR}`);
  assert.equal(regressions.length, 0, `corpus regression(s):\n${regressions.join("\n")}`);
});
