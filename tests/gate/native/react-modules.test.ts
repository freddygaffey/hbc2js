// tests/gate/native/react-modules.test.ts
// docs/specs/27-native-side.md §L2 — RN native-module registration extraction
// over L1's classes/methods tables. Property-based (round-trip / invariant),
// never a golden-output compare against a shared fixture (CLAUDE.md testing
// rules); exercised against `tests/fixtures/native/rn-modules.apk`, an
// L2-private fixture (`tools/native-fixture/gen.mjs`) that never touches the
// L1-pinned `synthetic.apk` / `no-resources.apk` bytes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNativeTables, openApk } from "../../../src/native/ingest.ts";
import type { NativeModuleRow } from "../../../src/native/schema.ts";

const APK = "tests/fixtures/native/rn-modules.apk";

function rows(): readonly NativeModuleRow[] {
  return buildNativeTables(openApk(APK)).reactModules;
}

function byImplClassSuffix(rows: readonly NativeModuleRow[], suffix: string): NativeModuleRow {
  const row = rows.find((r) => r.implClass.endsWith(suffix));
  assert.ok(row !== undefined, `no react-modules row with implClass ending ${suffix}`);
  return row!;
}

test("a bridge module's name is taken from @ReactModule(name) when present", () => {
  const row = byImplClassSuffix(rows(), "CryptoBridge;");
  assert.equal(row.jsName, "CryptoBridge");
  assert.equal(row.nameEvidence, "annotation");
  assert.equal(row.kind, "bridge");
  // The class also HAS a getName() const-string body ("ShouldNeverWin") that
  // must NOT win over the annotation (truth rule: the strongest evidence, not
  // the first found, and never invented).
  assert.notEqual(row.jsName, "ShouldNeverWin");
});

test("a bridge module with only getName()-const has its name recovered and marked getName-const", () => {
  const row = byImplClassSuffix(rows(), "TrivialNameModule;");
  assert.equal(row.jsName, "TrivialName");
  assert.equal(row.nameEvidence, "getName-const");
  assert.equal(row.kind, "bridge");
});

test("@ReactMethod methods appear as exported, non-@ReactMethod methods do not", () => {
  const row = byImplClassSuffix(rows(), "CryptoBridge;");
  const exportedNames = row.methods.map((m) => m.jsName);
  assert.deepEqual(exportedNames, ["doWork"]);
  assert.ok(!exportedNames.includes("internalOnly"), "a non-@ReactMethod method must not be exported");
  assert.ok(!exportedNames.includes("getName"), "getName() itself is not a @ReactMethod export");
});

test("a TurboModule spec class is classified turbo with its abstract methods as the surface", () => {
  const row = byImplClassSuffix(rows(), "NativeStatsSpec;");
  assert.equal(row.kind, "turbo");
  assert.equal(row.jsName, "Stats");
  const exportedNames = row.methods.map((m) => m.jsName).sort();
  assert.deepEqual(exportedNames, ["getStats", "reset"]);
});

test("a class that is not an RN module produces no row", () => {
  const all = rows();
  assert.ok(
    all.every((r) => !r.implClass.endsWith("PlainUtil;")),
    "PlainUtil (extends java.lang.Object, no RN base class) must produce no react-modules row",
  );
});

test("an unresolvable module name is unresolved, never invented", () => {
  const row = byImplClassSuffix(rows(), "UnresolvedModule;");
  assert.equal(row.jsName, null);
  assert.equal(row.nameEvidence, "unresolved");
  // Still emitted, not dropped: a real, honest fact.
  assert.equal(row.kind, "bridge");
});

test("a (Simple)ViewManager's name is recovered the same getName-const way", () => {
  const row = byImplClassSuffix(rows(), "StatsViewManager;");
  assert.equal(row.kind, "viewmanager");
  assert.equal(row.jsName, "StatsView");
  assert.equal(row.nameEvidence, "getName-const");
});

test("every react-modules row's key and implClass round-trip against classes.jsonl", () => {
  const t = buildNativeTables(openApk(APK));
  const classKeys = new Set(t.classes.map((c) => c.key));
  for (const r of t.reactModules) {
    assert.ok(classKeys.has(r.implClass), `${r.key} cites implClass ${r.implClass}, which is not in classes.jsonl`);
    assert.equal(r.firstParty, null, "firstParty is filled by L4, always null at L2");
  }
});
