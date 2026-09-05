// tests/gate/native/classify-party.test.ts
// docs/specs/27-native-side.md §L4 — first-party vs third-party labelling.
// Property-based, exact-name/exact-prefix checks against an L4-private
// fixture (`tests/fixtures/native/party.apk`, tools/native-fixture/gen.mjs);
// never a golden-output compare against a shared fixture (CLAUDE.md testing
// rules). The four tests are the ones spec 27 §L4 lists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { buildNativeTables, openApk } from "../../../src/native/ingest.ts";
import { classifyParty, isUnderJavaPackage, packageOfDescriptor } from "../../../src/native/classify-party.ts";
import { THIRD_PARTY_NATIVE_PACKAGES } from "../../../src/native/third-party-packages.ts";
import type { NativeModuleRow } from "../../../src/native/schema.ts";

const APK = join(repoRoot(), "tests", "fixtures", "native", "party.apk");

function rows(): readonly NativeModuleRow[] {
  const tables = buildNativeTables(openApk(APK));
  assert.equal(tables.manifest.package, "com.example.party");
  return tables.reactModules;
}

function byImplClassSuffix(all: readonly NativeModuleRow[], suffix: string): NativeModuleRow {
  const row = all.find((r) => r.implClass.endsWith(suffix));
  assert.ok(row !== undefined, `no react-modules row with implClass ending ${suffix}`);
  return row!;
}

test("a class under the manifest package is first-party", () => {
  const row = byImplClassSuffix(rows(), "CustomModule;");
  assert.equal(row.jsName, "Custom");
  assert.equal(row.firstParty, true);
});

test("a class under a curated third-party prefix is third-party", () => {
  const row = byImplClassSuffix(rows(), "GestureHandlerModule;");
  assert.equal(row.jsName, "GestureHandler");
  assert.equal(row.firstParty, false);
});

test("a class under neither list is null, not forced", () => {
  const row = byImplClassSuffix(rows(), "FooModule;");
  assert.equal(row.jsName, "Foo");
  assert.equal(row.firstParty, null);
});

test("the curated third-party list agrees with the deps sigdb where they overlap", () => {
  const sigdbPath = join(repoRoot(), "tools", "pkgsig", "db", "index.json");
  const sigdb = JSON.parse(readFileSync(sigdbPath, "utf8")) as { entries: { package: string }[] };
  const sigdbPackages = new Set(sigdb.entries.map((e) => e.package));

  // At least one curated entry's npm citation must actually appear in the
  // sigdb (pinned, not vacuous): today it is
  // @react-native-async-storage/async-storage (`com.reactnativecommunity`)
  // and react-native-gesture-handler (`com.swmansion`). If this ever fires
  // zero, the two channels have drifted apart.
  const overlap = THIRD_PARTY_NATIVE_PACKAGES.filter((e) => sigdbPackages.has(e.npmPackage));
  const byNpmPackage = (a: { npmPackage: string }, b: { npmPackage: string }): number => (a.npmPackage < b.npmPackage ? -1 : 1);
  assert.deepEqual(
    [...overlap].sort(byNpmPackage).map((e) => ({ npmPackage: e.npmPackage, prefix: e.prefix })),
    [
      { npmPackage: "@react-native-async-storage/async-storage", prefix: "com.reactnativecommunity" },
      { npmPackage: "react-native-gesture-handler", prefix: "com.swmansion" },
    ],
  );
});

test("packageOfDescriptor / isUnderJavaPackage are dot-bounded, not substring matches", () => {
  assert.equal(packageOfDescriptor("Lcom/swmansion/gesturehandler/GestureHandlerModule;"), "com.swmansion.gesturehandler");
  assert.equal(packageOfDescriptor("not-a-descriptor"), null);
  assert.ok(isUnderJavaPackage("com.swmansion.gesturehandler", "com.swmansion"));
  assert.ok(!isUnderJavaPackage("com.swmansion2.x", "com.swmansion"), "prefix match must be dot-bounded");
});

test("classifyParty refuses to classify a key that is not a native:type: key", () => {
  assert.equal(classifyParty("native:module:Foo", "com.example.party"), null);
});
