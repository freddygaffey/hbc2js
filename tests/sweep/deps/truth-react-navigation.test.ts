// docs/DECISIONS.md D17d for the react-navigation-example fixture. Its
// fetch.sh writes `react-navigation-example.map` (Metro source map) and
// `deps-truth.json` alongside the bundle when re-run; neither is committed
// (the map is several MB and the repo carries only the .hbc twins), so this
// is INCONCLUSIVE-via-skip until fetch.sh has been run locally.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { requireSweep } from "../../support/tiers.ts";
// @ts-expect-error — plain-JS tool, no declaration file.
import { scoreAgainstTruth, formatScore } from "../../../tools/deps-truth.mjs";

const DIR = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3");

for (const variant of ["react-navigation-example.hbc", "react-navigation-example.debug.hbc"]) {
  test(`deps-truth ${variant}: zero confirmed-tier false positives against the source-map truth`, async (t) => {
    if (!requireSweep(t)) return;
    const truthPath = join(DIR, "deps-truth.json");
    if (!existsSync(truthPath) || !existsSync(join(DIR, variant))) {
      t.skip(`${truthPath} not present — run fetch.sh (INCONCLUSIVE, not a failure)`);
      return;
    }
    const s = await scoreAgainstTruth(join(DIR, variant), JSON.parse(readFileSync(truthPath, "utf8")));
    console.log(formatScore(s));
    assert.ok(s.hbcSha256Matches);
    assert.deepEqual(s.confirmed.falsePositives, []);
  });
}
