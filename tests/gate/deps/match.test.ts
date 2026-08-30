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
import type { ModuleInventory } from "../../../src/deps/inventory.ts";
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";

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

// D17d regression (docs/PACKAGE-SIGNATURES.md §6.6): measured live against
// react-navigation-example-0.85.3 with a fixed bulk signature DB layered in,
// `js-md5` and `@emotion/react` cleared the old "high" tier off a *single*
// coincidentally-matching module each (js-md5: 1/2 non-baseline modules =
// 50% module coverage; @emotion/react: 1/16-17 ≈ 6%) — neither package is
// anywhere near this fixture's real dependency tree. These two real
// signature files (extracted from the fixed bulk DB on 2026-08-30, the
// exact versions/hashes that produced the false positive) are committed as
// a minimal, offline reproducer so the fix doesn't need the multi-MB bulk
// archive or the uncommitted react-navigation-example bundle to stay
// covered by `npm test`.
const TINY_COLLISION_DIR = join(repoRoot(), "tests", "fixtures", "sigdb", "tiny-package-collision");

function loadFixtureSig(filename: string): SigDbFile {
  return JSON.parse(readFileSync(join(TINY_COLLISION_DIR, filename), "utf8")) as SigDbFile;
}

/** A minimal synthetic target inventory containing exactly the given
 *  function-level exact hashes and nothing else — enough for `matchInventory`
 *  to score package tiers (which only consults `inventory.functions`, not
 *  `inventory.modules`, for `scorePackage`'s own per-package tier logic). */
function inventoryWithExactHashes(hbcVersion: number, entries: readonly { readonly hash: string; readonly instrCount: number }[]): ModuleInventory {
  return {
    hbcVersion,
    totalFunctions: entries.length,
    moduledFunctionCount: entries.length,
    modules: [],
    functions: entries.map((e, i) => ({
      index: i,
      name: "",
      paramCount: 0,
      instrCount: e.instrCount,
      exactHash: e.hash,
      fuzzyHash: `nonmatching-fuzzy-${i}`,
      stringSetHash: `nonmatching-strings-${i}`,
      stringCount: 0,
    })),
  };
}

function loadTinyCollisionDb() {
  const layers = resolveDbLayers({ outDir: "/nonexistent-project-dir-for-this-test", sigdb: TINY_COLLISION_DIR, noSharedDb: true });
  return loadSignatures(layers);
}

for (const [pkgFile, pkgName] of [
  ["js-md5@0.8.1__hbc98.json", "js-md5"],
  ["@emotion__react@11.10.5__hbc98.json", "@emotion/react"],
] as const) {
  test(`D17d regression: ${pkgName} does not reach "high" off a single coincidentally-matching module`, () => {
    const pkg = loadFixtureSig(pkgFile);
    const collidingModule = pkg.modules.find((m) => !m.factoryIsBaseline && m.factoryExactHash !== null)!;
    assert.ok(collidingModule !== undefined, `expected a non-baseline hashed module in ${pkgFile}`);
    const collidingFn = pkg.functions.find((f) => f.exactHash === collidingModule.factoryExactHash)!;
    const inventory = inventoryWithExactHashes(pkg.hbcVersion, [{ hash: collidingModule.factoryExactHash!, instrCount: collidingFn.instrCount }]);
    const report = matchInventory(inventory, loadTinyCollisionDb());
    const score = report.packages.find((p) => p.package === pkgName);
    assert.ok(score !== undefined, `expected ${pkgName} to be scored at all (1 module hit should still register)`);
    assert.notEqual(score!.tier, "high", `${pkgName} must not reach "high" off a single coincidental module hit (docs/PACKAGE-SIGNATURES.md §6.6)`);
  });
}

test('D17d regression: js-md5 (a tiny, 2-module package) CAN still reach "high" via several substantial exact-matched functions, not one', () => {
  const pkg = loadFixtureSig("js-md5@0.8.1__hbc98.json");
  // Every eligible (>=8 instr) function of the real module — not the
  // package's other, unrelated 2-instruction module — genuinely matching is
  // qualitatively different evidence from one coincidental hit.
  const eligible = pkg.functions.filter((f) => f.instrCount >= 8);
  assert.ok(eligible.length >= 5, "fixture must have enough eligible functions for this positive control");
  const inventory = inventoryWithExactHashes(
    pkg.hbcVersion,
    eligible.map((f) => ({ hash: f.exactHash, instrCount: f.instrCount })),
  );
  const report = matchInventory(inventory, loadTinyCollisionDb());
  const score = report.packages.find((p) => p.package === "js-md5");
  assert.ok(score !== undefined);
  assert.equal(score!.tier, "high", "genuine, multi-function evidence for a tiny package must still reach \"high\" — the fix must not overshoot into blocking real detections");
});

test('D17d regression: @emotion/react CAN still reach "high" via several independent module hits plus real function-level coverage', () => {
  const pkg = loadFixtureSig("@emotion__react@11.10.5__hbc98.json");
  const nonBaselineModules = pkg.modules.filter((m) => !m.factoryIsBaseline && m.factoryExactHash !== null);
  assert.ok(nonBaselineModules.length >= 2, "fixture must have >=2 non-baseline hashed modules for this positive control");
  const eligible = pkg.functions.filter((f) => f.instrCount >= 8);
  // Clear the coverage-percentage path's function-level floor (10%) with
  // margin: the first ~15% of the package's own eligible functions,
  // guaranteed to include the 2 module factory hashes below since a
  // factory's own function entry is itself eligible.
  const hashes = new Set<string>();
  const entries: { hash: string; instrCount: number }[] = [];
  for (const m of nonBaselineModules.slice(0, 2)) {
    const fn = pkg.functions.find((f) => f.exactHash === m.factoryExactHash)!;
    if (!hashes.has(fn.exactHash)) {
      hashes.add(fn.exactHash);
      entries.push({ hash: fn.exactHash, instrCount: fn.instrCount });
    }
  }
  for (const f of eligible) {
    if (entries.length >= Math.ceil(eligible.length * 0.15) + 2) break;
    if (hashes.has(f.exactHash)) continue;
    hashes.add(f.exactHash);
    entries.push({ hash: f.exactHash, instrCount: f.instrCount });
  }
  const inventory = inventoryWithExactHashes(pkg.hbcVersion, entries);
  const report = matchInventory(inventory, loadTinyCollisionDb());
  const score = report.packages.find((p) => p.package === "@emotion/react");
  assert.ok(score !== undefined);
  assert.ok(score!.moduleExactHits >= 2, `expected >=2 module hits in this positive control, got ${score!.moduleExactHits}`);
  assert.equal(score!.tier, "high", "genuine multi-module + broad function-level evidence must still reach \"high\"");
});
