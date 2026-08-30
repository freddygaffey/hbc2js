// docs/DECISIONS.md D17d — ground truth from our own build. The
// rn-template-0.72/truth fixture is a rebuild of the template with Metro's
// source map; `deps-truth.json` maps every Metro module id to the npm
// package@version its source lives in (tools/deps-truth.mjs). Gate:
// confirmed-tier false positives must be zero, for the release and the -g
// build alike; guessed-tier precision and per-module accuracy are reported
// (docs/DEPS.md), not gated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
// @ts-expect-error — plain-JS tool, no declaration file.
import { scoreAgainstTruth, formatScore } from "../../../tools/deps-truth.mjs";

const TRUTH_DIR = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "truth");
const truth = JSON.parse(readFileSync(join(TRUTH_DIR, "deps-truth.json"), "utf8"));

for (const variant of ["index.android.hbc", "index.android.debug.hbc"]) {
  test(`deps-truth ${variant}: zero confirmed-tier false positives, both direct dependencies confirmed`, async () => {
    const s = await scoreAgainstTruth(join(TRUTH_DIR, variant), truth);
    console.log(formatScore(s).split("\n").slice(0, 4).join("\n"));
    assert.ok(s.hbcSha256Matches, "fixture .hbc must be the one the truth file was derived from");
    assert.deepEqual(s.confirmed.falsePositives, []);
    assert.equal(s.confirmed.precision, 1);
    assert.equal(s.confirmed.directRecall, 1, `direct deps ${s.directPackages.join(",")} must all be confirmed`);
    assert.deepEqual(s.versionMismatches, []);
    assert.deepEqual(s.guessed.falsePositives, [], "the template has no third-party deps: a guessed package is a false positive");
    assert.equal(s.perModule.appModulesAttributed, 0);
    assert.ok(s.perModule.accuracy >= 0.7, `per-module accuracy ${s.perModule.accuracy}`);
  });
}
