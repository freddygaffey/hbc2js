#!/usr/bin/env node
// tools/pkgsig/d17f-score.mjs — D17f proof-of-concept scoring: runs
// `hbc2js deps` (via tools/deps-truth.mjs's scoreAgainstTruth, reused
// as-is) against tests/fixtures/bundles/react-navigation-example-0.85.3/
// twice — (a) shared starter DB only, (b) shared DB + the exact-version
// scratch DB that d17f-build-exact-db.mjs writes — and prints both reports
// plus a before/after summary. See docs/DEPS.md "D17f proof" for the
// numbers this produced and their interpretation.
//
// Prerequisites:
//   - tests/fixtures/bundles/react-navigation-example-0.85.3/fetch.sh has
//     been run (the .hbc + deps-truth.json aren't committed — too big/a
//     build artefact, see that fixture's BUILD.md).
//   - node tools/pkgsig/d17f-build-exact-db.mjs <scratchDir> has been run,
//     and the 7 ALREADY_IN_SHARED_DB signature files it lists have been
//     copied from tools/pkgsig/db/ into <scratchDir>/sigdb/ alongside the
//     ones it built.
//
// Usage: node tools/pkgsig/d17f-score.mjs [scratchDir]
//   scratchDir defaults to /tmp/hbc2js-d17f-proof (same default as
//   d17f-build-exact-db.mjs).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreAgainstTruth, formatScore } from "../deps-truth.mjs";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");
const FIXTURE = join(REPO, "tests/fixtures/bundles/react-navigation-example-0.85.3");
const HBC = join(FIXTURE, "react-navigation-example.hbc");
const SCRATCH = process.argv[2] ?? "/tmp/hbc2js-d17f-proof";
const SCRATCH_DB = join(SCRATCH, "sigdb");

const truth = JSON.parse(readFileSync(join(FIXTURE, "deps-truth.json"), "utf8"));

console.log("############ (a) SHARED STARTER DB ONLY ############");
const before = await scoreAgainstTruth(HBC, truth, { offline: true });
console.log(formatScore(before));

console.log("\n\n############ (b) SHARED DB + EXACT-VERSION SCRATCH DB LAYERED ############");
const after = await scoreAgainstTruth(HBC, truth, { offline: true, sigdb: SCRATCH_DB });
console.log(formatScore(after));

console.log("\n\n############ SUMMARY ############");
console.log(
  JSON.stringify(
    {
      before: { confirmedCount: before.confirmed.reported.length, recall: before.confirmed.recall, directRecall: before.confirmed.directRecall, moduleAccuracy: before.perModule.accuracy, weightAccuracy: before.perModuleByWeight.accuracy, falsePositives: before.confirmed.falsePositives },
      after: { confirmedCount: after.confirmed.reported.length, recall: after.confirmed.recall, directRecall: after.confirmed.directRecall, moduleAccuracy: after.perModule.accuracy, weightAccuracy: after.perModuleByWeight.accuracy, falsePositives: after.confirmed.falsePositives },
    },
    null,
    2,
  ),
);
