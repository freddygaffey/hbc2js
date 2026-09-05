// tests/gate/native/native-deps.test.ts
// docs/specs/27-native-side.md §L7 — the known-lib native shortcut and its
// merge into `src/deps`'s report. Property-based against `buildNativeChannel`
// / `nativePackageForImplClass` directly (pure functions), fed real L4-shaped
// rows from the L4-private fixture (`tests/fixtures/native/party.apk`) plus a
// synthesised JS-fingerprint package set — never a golden-output compare
// against a shared fixture (CLAUDE.md testing rules).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { buildNativeTables, openApk } from "../../../src/native/ingest.ts";
import { buildNativeChannel, nativePackageForImplClass } from "../../../src/native/native-deps.ts";
import type { NativeModuleRow } from "../../../src/native/schema.ts";

const APK = join(repoRoot(), "tests", "fixtures", "native", "party.apk");

function partyModules(): readonly NativeModuleRow[] {
  return buildNativeTables(openApk(APK)).reactModules;
}

function byImplClassSuffix(all: readonly NativeModuleRow[], suffix: string): NativeModuleRow {
  const row = all.find((r) => r.implClass.endsWith(suffix));
  assert.ok(row !== undefined, `no react-modules row with implClass ending ${suffix}`);
  return row!;
}

test("a known third-party native package resolves to its npm name", () => {
  const gestureHandler = byImplClassSuffix(partyModules(), "GestureHandlerModule;");
  assert.equal(gestureHandler.firstParty, false);
  assert.equal(nativePackageForImplClass(gestureHandler.implClass), "react-native-gesture-handler");
});

test("a native-identified lib that JS-fingerprinting missed appears with channel:native-only", () => {
  const modules = partyModules();
  const { deps } = buildNativeChannel(modules, new Set());
  const dep = deps.find((d) => d.package === "react-native-gesture-handler");
  assert.ok(dep !== undefined);
  assert.equal(dep!.channel, "native-only");
  assert.deepEqual(dep!.evidence, ["native-package"]);
});

test("a lib found by both channels appears once with both evidence tags", () => {
  const modules = partyModules();
  const jsFoundPackages = new Set(["react-native-gesture-handler"]);
  const { deps } = buildNativeChannel(modules, jsFoundPackages);
  const matches = deps.filter((d) => d.package === "react-native-gesture-handler");
  assert.equal(matches.length, 1, "must be de-duplicated, not one row per channel");
  assert.equal(matches[0]!.channel, "both");
  assert.deepEqual(matches[0]!.evidence, ["native-package", "js-fingerprint"]);
});

test("a first-party (app-namespace) module is never emitted as an npm dependency", () => {
  const modules = partyModules();
  const customModule = byImplClassSuffix(modules, "CustomModule;");
  assert.equal(customModule.firstParty, true);
  const foo = byImplClassSuffix(modules, "FooModule;");
  assert.equal(foo.firstParty, null); // unknown, also never emitted (no curated mapping)
  assert.equal(nativePackageForImplClass(foo.implClass), null);

  const { deps } = buildNativeChannel(modules, new Set());
  // Only the curated third-party GestureHandler row survives; the
  // first-party CustomModule and the unknown FooModule contribute nothing,
  // whether or not their (fictitious, for this fixture) package would ever
  // resolve to a curated npm name.
  assert.deepEqual(deps.map((d) => d.package), ["react-native-gesture-handler"]);
});
