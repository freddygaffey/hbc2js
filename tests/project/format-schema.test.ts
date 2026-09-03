// P1 (spec 11 §6, pre-implementation, hand-written sample) — envelope +
// schema self-consistency of the project store's on-disk JSONL format (§2.1,
// §2.2). Step 0 wrote this against test-local logic because no `src/project/*`
// module existed yet; step 2 (spec 11 §7) shipped the real schema/io layer,
// so this file now asserts the exact same rules through `src/project/schema.ts`
// + `src/project/io.ts` against the same hand-written fixture at
// `tests/project/sample-store/project/`. Mirrors spec 10's A1 shape
// (`docs/specs/10-artifact-format.md` §7) for a new sidecar family.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSchemaHeader, ENVELOPE_FIELDS, PROJECT_DIR_FILES, RECORD_FILE_NAMES, type RecordFileKind } from "../../src/project/schema.ts";
import { loadRecordFile, assertSorted, loadProjectStore, saveProjectStore } from "../../src/project/io.ts";

const dir = new URL("./sample-store/project/", import.meta.url).pathname;

const RECORD_FILES: Record<string, RecordFileKind> = {
  "comments.jsonl": "comments",
  "tags.jsonl": "tags",
  "bookmarks.jsonl": "bookmarks",
  "findings.jsonl": "findings",
};

function lines(file: string): string[] {
  return readFileSync(join(dir, file), "utf8").trim().split("\n");
}

test("P1a every record file has a schema header naming its kind", () => {
  for (const [file, expectedKind] of Object.entries(RECORD_FILES)) {
    const head = parseSchemaHeader(lines(file)[0] as string, expectedKind);
    assert.equal(head.schema, "hbc2js-project/1");
    assert.equal(head.kind, expectedKind);
  }
});

test("P1b unknown major schema is refused, not silently accepted", () => {
  assert.throws(() => parseSchemaHeader('{"schema":"hbc2js-project/2","kind":"tags"}'), /unknown project-store schema major/);
  assert.throws(() => parseSchemaHeader('{"schema":"not-a-project-schema","kind":"tags"}'), /unknown project-store schema major/);
  assert.throws(() => parseSchemaHeader('{"kind":"tags"}'), /malformed schema header/);
});

test("P1c every record carries the full §2.1 envelope", () => {
  assert.deepEqual([...ENVELOPE_FIELDS], ["rid", "kind", "target", "prov", "ts", "supersedes", "active", "ctx"]);
  for (const [file, kind] of Object.entries(RECORD_FILES)) {
    const { rows } = loadRecordFile(join(dir, file), kind);
    assert.ok(rows.length > 0, `${file}: fixture has no rows`);
  }
});

test("P1d rows are sorted by (target, rid)", () => {
  for (const [file, kind] of Object.entries(RECORD_FILES)) {
    const { rows } = loadRecordFile<{ target: string; rid: string }>(join(dir, file), kind);
    assertSorted(rows, file);
  }
});

test("P1e project.json header records schema and builtFor.bundleSha256", () => {
  const header = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as {
    schema: string;
    builtFor: { bundleSha256: string };
  };
  assert.equal(header.schema, "hbc2js-project/1");
  assert.match(header.builtFor.bundleSha256, /^[0-9a-f]{64}$/);
});

test("P1f the fixture directory has exactly the §2.2 file set", () => {
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ["bookmarks.jsonl", "comments.jsonl", "findings.jsonl", "project.json", "tags.jsonl"]);
  assert.deepEqual(files, PROJECT_DIR_FILES);
  assert.deepEqual(Object.values(RECORD_FILE_NAMES).sort(), ["bookmarks.jsonl", "comments.jsonl", "findings.jsonl", "tags.jsonl"]);
});

test("P1g load -> save round-trips the sample store byte-identically", () => {
  // The hand-written fixture is the truth for on-disk BYTES: loading it into
  // typed records and writing it straight back out must reproduce every file
  // exactly, proving `serializeRecordFile`/`saveProjectHeader` don't silently
  // reorder keys, rewrite numbers, or change whitespace (§2.2 byte
  // determinism, same discipline as the overlay sidecar).
  const scratch = mkdtempSync(join(tmpdir(), "hbc2js-project-roundtrip-"));
  const storeDir = join(scratch, "project");
  cpSync(dir, storeDir, { recursive: true });
  try {
    const before: Record<string, string> = {};
    for (const f of PROJECT_DIR_FILES) before[f] = readFileSync(join(storeDir, f), "utf8");

    const store = loadProjectStore(storeDir);
    saveProjectStore(store);

    for (const f of PROJECT_DIR_FILES) {
      const after = readFileSync(join(storeDir, f), "utf8");
      assert.equal(after, before[f], `${f} did not round-trip byte-identically`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
