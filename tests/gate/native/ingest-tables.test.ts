// tests/gate/native/ingest-tables.test.ts
// ACCEPTANCE: spec 27 (docs/specs/27-native-side.md L1 — the ingest orchestrator
// that writes native/{classes,methods,strings,resources,assets}.jsonl +
// native/manifest.json under <artifact>/native/, and the tools/artifact/
// check-native.ts re-walker, spec 27 §L1 + §4). Shipped skipped with the spec,
// before implementation; property-based, against the hermetic synthetic APK
// fixture (spec 27 §3). Truth rules (spec 27 §4): recomputable + re-walk agrees;
// assets are inventory-only (no bytes copied into any table); an absent input
// yields zero rows + a note, never an error and never a fabricated row.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ingestNative, openApk } from "../../../src/native/ingest.ts";
import { NATIVE_SCHEMA, parseNativeJsonl } from "../../../src/native/schema.ts";
import { checkNative } from "../../../tools/artifact/check-native.ts";

const APK = "tests/fixtures/native/synthetic.apk";
const BARE_APK = "tests/fixtures/native/no-resources.apk";

function ingestInto(apk: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-native-"));
  ingestNative(openApk(apk), dir);
  return dir;
}

function readTable(dir: string, file: string): { header: { kind: string; source: string }; rows: Record<string, unknown>[] } {
  const parsed = parseNativeJsonl(readFileSync(join(dir, "native", file), "utf8"));
  return { header: parsed.header as unknown as { kind: string; source: string }, rows: parsed.rows as Record<string, unknown>[] };
}

test("ingest: writes native/*.jsonl with schema headers and primary-key sort", () => {
  const dir = ingestInto(APK);
  const expected: [string, string, string, string][] = [
    ["classes.jsonl", "classes", "dex", "key"],
    ["methods.jsonl", "methods", "dex", "key"],
    ["resources.jsonl", "resources", "arsc", "key"],
    ["assets.jsonl", "assets", "zip", "path"],
  ];
  for (const [file, kind, source, primaryKey] of expected) {
    const { header, rows } = readTable(dir, file);
    assert.equal((header as unknown as { schema: string }).schema, NATIVE_SCHEMA);
    assert.equal(header.kind, kind);
    assert.equal(header.source, source);
    assert.ok(rows.length > 0, `${file} should have rows for this fixture`);
    const keys = rows.map((r) => String(r[primaryKey]));
    assert.deepEqual(keys, [...keys].sort(), `${file} is not sorted by its primary key ${primaryKey}`);
  }
  // strings.jsonl's primary key is (dex, index).
  const strings = readTable(dir, "strings.jsonl");
  assert.equal(strings.header.kind, "strings");
  const ordinals = strings.rows.map((r) => Number(r["dex"]) * 1e6 + Number(r["i"]));
  assert.deepEqual(ordinals, [...ordinals].sort((a, b) => a - b));
  // native/manifest.json is the Android manifest projection, not a JSONL table.
  const manifest = JSON.parse(readFileSync(join(dir, "native", "manifest.json"), "utf8")) as { package: string; components: unknown[] };
  assert.equal(manifest.package, "com.example.app");
  assert.equal(manifest.components.length, 2);
  // Byte-for-byte recomputable: the same bytes give the same files (§4.1).
  const again = ingestInto(APK);
  for (const f of readdirSync(join(dir, "native"))) {
    if (f === "ingest.json") continue; // carries the source path, which differs
    assert.equal(readFileSync(join(dir, "native", f), "utf8"), readFileSync(join(again, "native", f), "utf8"), `${f} is not recomputable`);
  }
});

test("ingest: check-native re-walk agrees with the builder row-for-row on the fixture", () => {
  const dir = ingestInto(APK);
  const report = checkNative(dir, APK);
  assert.deepEqual([...report.problems], []);
  assert.equal(report.ok, true);
  assert.deepEqual(report.actual, report.expected);
  // The re-walk's counts are the table lengths, not just each other.
  assert.equal(report.actual.classes, readTable(dir, "classes.jsonl").rows.length);
  assert.equal(report.actual.methods, readTable(dir, "methods.jsonl").rows.length);
  assert.equal(report.actual.strings, readTable(dir, "strings.jsonl").rows.length);
  // Internal consistency: every method row names a class that has a row.
  const classKeys = new Set(readTable(dir, "classes.jsonl").rows.map((r) => String(r["key"])));
  for (const m of readTable(dir, "methods.jsonl").rows) assert.ok(classKeys.has(String(m["class"])), `${String(m["key"])} has no class row`);
  // A tampered artifact is caught rather than passed.
  const bad = ingestInto(APK);
  const path = join(bad, "native", "classes.jsonl");
  const kept = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  writeFileSync(path, kept.slice(0, kept.length - 1).join("\n") + "\n");
  assert.equal(checkNative(bad, APK).ok, false);
});

test("ingest: assets.jsonl is inventory-only — no asset bytes appear in any table", () => {
  const dir = ingestInto(APK);
  const { rows } = readTable(dir, "assets.jsonl");
  assert.ok(rows.length >= 2);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ["kind", "path", "sha256", "size"]);
    assert.match(String(r["sha256"]), /^[0-9a-f]{64}$/);
    assert.ok(Number(r["size"]) > 0);
  }
  // The asset's actual content must not have been copied anywhere (§4.4).
  const container = openApk(APK);
  for (const name of container.list().filter((n) => n.startsWith("assets/"))) {
    const bytes = container.read(name);
    assert.ok(bytes !== null);
    const content = new TextDecoder().decode(bytes).trim();
    assert.ok(content.length > 0);
    for (const file of readdirSync(join(dir, "native"))) {
      const text = readFileSync(join(dir, "native", file), "utf8");
      assert.ok(!text.includes(content), `${file} contains the bytes of ${name}; assets are inventory-only`);
    }
  }
});

test("ingest: absent resources.arsc yields zero resource rows + a note, never an error and never a fabricated row", () => {
  const container = openApk(BARE_APK);
  assert.ok(!container.list().includes("resources.arsc"), "the bare fixture must have no resources.arsc");
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-native-"));
  const result = ingestNative(container, dir); // must not throw
  assert.equal(result.tables.resources.length, 0);
  const { header, rows } = readTable(dir, "resources.jsonl");
  assert.equal(header.kind, "resources");
  assert.deepEqual(rows, []);
  assert.ok(
    result.provenance.notes.some((n) => n.includes("resources.arsc")),
    `expected a note about the absent resources.arsc, got ${JSON.stringify(result.provenance.notes)}`,
  );
  assert.equal(result.provenance.counts["resources"], 0);
  // The rest of the container is still ingested: absence is local, not fatal.
  assert.ok(result.tables.classes.length > 0);
  assert.equal(result.tables.assets.length, 0);
  assert.equal(result.tables.manifest.package, "com.example.app");
});
