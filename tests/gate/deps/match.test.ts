// docs/DECISIONS.md D17/D17a/D17b — the offline match-stage gate: against
// the shared starter DB (tools/pkgsig/db), rn-template-0.72 must resolve to
// react + react-native at high confidence, and must NOT resolve to lodash
// (never in this fixture's dependency tree at all — docs/PACKAGE-SIGNATURES.md
// §2.1/§2.4's own false-positive control).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { repoRoot } from "../../support/paths.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { resolveDbLayers, loadSignatures } from "../../../src/deps/db.ts";
import { matchInventory } from "../../../src/deps/match.ts";
import { buildReport } from "../../../src/deps/report.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

function matchRnTemplate() {
  const bytes = readFileSync(RN_TEMPLATE);
  const { inventory } = buildInventory(bytes);
  const layers = resolveDbLayers({ outDir: "/nonexistent-project-dir-for-this-test", noSharedDb: false });
  const dbs = loadSignatures(layers);
  const matchReport = matchInventory(inventory, dbs);
  return { inventory, matchReport };
}

test("shared DB: react-native matches rn-template-0.72 at high confidence", () => {
  const { matchReport } = matchRnTemplate();
  const rn = matchReport.packages.find((p) => p.package === "react-native" && !p.isBaseline);
  assert.ok(rn !== undefined, "expected a non-baseline react-native@... entry in the shared DB");
  assert.equal(rn!.tier, "high");
  assert.ok(rn!.exactCoverage > 0.9, `expected >90% exact coverage, got ${(rn!.exactCoverage * 100).toFixed(1)}%`);
});

test("shared DB: react matches rn-template-0.72 (module-anchored high confidence)", () => {
  const { matchReport } = matchRnTemplate();
  const react = matchReport.packages.find((p) => p.package === "react" && !p.isBaseline);
  assert.ok(react !== undefined, "expected a non-baseline react@... entry in the shared DB");
  assert.equal(react!.tier, "high");
});

test("shared DB: lodash is never reported as a confirmed dependency of rn-template-0.72", () => {
  const { matchReport } = matchRnTemplate();
  const lodash = matchReport.packages.find((p) => p.package === "lodash");
  assert.ok(lodash !== undefined, "expected the starter DB to include a lodash signature to test against");
  assert.notEqual(lodash!.tier, "high", `lodash must not reach "high" confidence against a fixture that never depends on it (got exact ${(lodash!.exactCoverage * 100).toFixed(1)}%)`);
});

test("hbc2js deps report: react + react-native confirmed, lodash absent from confirmedDeps", async () => {
  const { matchReport } = matchRnTemplate();
  // No network in this test: pass an empty guess list (the guess stage is
  // covered separately and independently in guess.test.ts) so this stays a
  // pure, offline match-stage assertion.
  const report = buildReport(RN_TEMPLATE, matchReport, []);

  const names = report.confirmedDeps.map((d) => d.package);
  assert.ok(names.includes("react-native"), `expected react-native in confirmedDeps, got: ${names.join(", ")}`);
  assert.ok(names.includes("react"), `expected react in confirmedDeps, got: ${names.join(", ")}`);
  assert.ok(!names.includes("lodash"), `lodash must not appear in confirmedDeps, got: ${names.join(", ")}`);

  // Real, specific version numbers (D17a: "package@version"), not just names.
  const rn = report.confirmedDeps.find((d) => d.package === "react-native")!;
  assert.equal(rn.version, "0.72.17");
  assert.equal(report.reactNativeVersion, "0.72.17");

  // No toolchain/foundation baseline artifact ever leaks into the report as
  // if it were a real npm package.
  assert.ok(!names.includes("metro-toolchain-empty"));
  assert.ok(!names.includes("react-foundation"));
  assert.ok(!names.includes("react-native-foundation"));

  assert.ok(report.attribution.percentAttributed > 90, `expected >90% module attribution for a fixture this well-covered by the starter DB, got ${report.attribution.percentAttributed.toFixed(1)}%`);
});
