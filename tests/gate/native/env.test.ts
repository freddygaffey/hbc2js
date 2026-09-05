// tests/gate/native/env.test.ts
// docs/specs/27-native-side.md §L6 -- `.env` recovery from strings.xml /
// BuildConfig, over L1's already-materialised `resources.jsonl` rows and a
// bounded set of `BuildConfig` static-field facts. Property-based (round-trip
// / invariant), never a golden-output compare against a shared fixture
// (CLAUDE.md testing rules); exercised against `tests/fixtures/native/
// env.apk`, an L6-private fixture (`tools/native-fixture/gen.mjs`) that never
// touches the other five pinned `.apk` fixtures' bytes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNativeTables, openApk } from "../../../src/native/ingest.ts";
import type { EnvRow } from "../../../src/native/schema.ts";

const APK = "tests/fixtures/native/env.apk";

function rows(): readonly EnvRow[] {
  return buildNativeTables(openApk(APK)).env;
}

test("an APIGEE-shaped strings.xml env key/value is recovered by the own parser", () => {
  const row = rows().find((r) => r.key === "API_URL");
  assert.ok(row !== undefined, "no env row for API_URL");
  assert.equal(row!.value, "https://api.example.test");
  assert.equal(row!.source, "strings.xml");
  assert.equal(row!.resolvedBy, "own-parser");
});

test("a BuildConfig field with no oracle is unresolved with its key present, never a guessed value", () => {
  const row = rows().find((r) => r.key === "API_SECRET");
  assert.ok(row !== undefined, "no env row for API_SECRET -- the key must still be emitted");
  assert.equal(row!.value, "unresolved");
  assert.equal(row!.source, "BuildConfig");
  assert.equal(row!.resolvedBy, "none");
});

test("a non-env string resource is not mislabelled as env", () => {
  const all = rows();
  assert.equal(
    all.find((r) => r.key === "app_label"),
    undefined,
    "app_label is a lower-case string resource, not env-key-shaped, and must not appear in env.jsonl",
  );
  // The underlying resource IS still available elsewhere (spec 27 §L6: the
  // env-key shape is a label/filter on this derived table, never a gate on
  // access to the resource itself).
  const resources = buildNativeTables(openApk(APK)).resources;
  assert.ok(
    resources.some((r) => r.key.endsWith("/app_label") && r.value === "Env Example App"),
    "app_label must still be a normal resources.jsonl row",
  );
});
