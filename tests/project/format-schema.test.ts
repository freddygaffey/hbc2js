// P1 (spec 11 §6, pre-implementation, hand-written sample) — envelope +
// schema self-consistency of the project store's on-disk JSONL format (§2.1,
// §2.2). This is the tests-only red harness that lands BEFORE any product
// code (impl-plan step 0, reviewer edit E5): it reads the hand-written
// fixture at `tests/project/sample-store/project/` directly and checks the
// FORMAT, not any `src/project/*` module (none exists yet). Mirrors spec 10's
// A1 shape (`docs/specs/10-artifact-format.md` §7) for a new sidecar family.
//
// Fields and rules asserted here come straight from spec 11 §2.1/§2.2 — the
// common envelope every record kind shares, the schema-header convention,
// "unknown major schema = refuse", and "rows sorted by (target, rid)".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("./sample-store/project/", import.meta.url).pathname;

/** File name -> the `kind` its schema header must declare (§2.2's layout). */
const RECORD_FILES: Record<string, string> = {
  "comments.jsonl": "comments",
  "tags.jsonl": "tags",
  "bookmarks.jsonl": "bookmarks",
  "findings.jsonl": "findings",
};

function lines(file: string): string[] {
  return readFileSync(join(dir, file), "utf8").trim().split("\n");
}

function rows(file: string): Record<string, unknown>[] {
  return lines(file)
    .slice(1)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The §2.1 common envelope every record carries regardless of `kind`. */
const ENVELOPE_FIELDS = ["rid", "kind", "target", "prov", "ts", "supersedes", "active", "ctx"] as const;

/** Reference parse of a schema header line, implementing §2.2's rule
 *  verbatim: "First line of each file is a schema header
 *  `{"schema":"hbc2js-project/1","kind":"tags"}`; unknown major schema =
 *  refuse." This is test-local logic over the FORMAT, not a product module —
 *  no `src/project/*` exists yet (step 0 ships no code, spec 11 §7). */
function parseHeader(line: string): { schema: string; kind: string } {
  const h = JSON.parse(line) as { schema?: unknown; kind?: unknown };
  if (typeof h.schema !== "string" || typeof h.kind !== "string") {
    throw new Error(`malformed schema header: ${line}`);
  }
  const m = /^hbc2js-project\/(\d+)$/.exec(h.schema);
  if (!m || m[1] !== "1") {
    throw new Error(`unknown project-store schema major, refusing: ${h.schema}`);
  }
  return { schema: h.schema, kind: h.kind };
}

test("P1a every record file has a schema header naming its kind", () => {
  for (const [file, expectedKind] of Object.entries(RECORD_FILES)) {
    const head = parseHeader(lines(file)[0] as string);
    assert.equal(head.schema, "hbc2js-project/1");
    assert.equal(head.kind, expectedKind);
  }
});

test("P1b unknown major schema is refused, not silently accepted", () => {
  assert.throws(() => parseHeader('{"schema":"hbc2js-project/2","kind":"tags"}'), /unknown project-store schema major/);
  assert.throws(() => parseHeader('{"schema":"not-a-project-schema","kind":"tags"}'), /unknown project-store schema major/);
  assert.throws(() => parseHeader('{"kind":"tags"}'), /malformed schema header/);
});

test("P1c every record carries the full §2.1 envelope", () => {
  for (const file of Object.keys(RECORD_FILES)) {
    for (const row of rows(file)) {
      for (const field of ENVELOPE_FIELDS) {
        assert.ok(field in row, `${file}: record ${JSON.stringify(row.rid)} is missing envelope field "${field}"`);
      }
      const prov = row.prov as Record<string, unknown>;
      assert.ok(["human", "llm", "tool"].includes(prov.source as string), `${file}: prov.source must be human|llm|tool`);
      assert.equal(typeof prov.who, "string");
      assert.equal(typeof row.rid, "string");
      assert.equal(typeof row.target, "string");
      assert.equal(typeof row.ts, "string");
      assert.ok(row.supersedes === null || typeof row.supersedes === "string");
      assert.equal(typeof row.active, "boolean");
      assert.equal(typeof row.ctx, "object");
    }
  }
});

test("P1d rows are sorted by (target, rid)", () => {
  for (const file of Object.keys(RECORD_FILES)) {
    const keys = rows(file).map((r) => [r.target as string, r.rid as string]);
    const sorted = [...keys].sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : a[1]! < b[1]! ? -1 : a[1]! > b[1]! ? 1 : 0));
    assert.deepEqual(keys, sorted, `${file} rows are not sorted by (target, rid)`);
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
});
