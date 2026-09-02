// tests/artifact/format-schema.test.ts  (verbatim; implementer materialises)
// Taken unchanged from docs/specs/10-artifact-format.md §7 (A1) per the
// spec's own step-0 instruction: "the implementer materialises it unchanged
// as step 0 — its assertions are the spec's, not the implementer's."
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const dir = new URL("./sample-artifact/", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const jsonl = (f: string) => readFileSync(join(dir, "index", f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
test("A1a every index file has a schema header", () => {
  for (const f of readdirSync(join(dir, "index")).filter((f) => f.endsWith(".jsonl"))) {
    const [head] = jsonl(f);
    assert.match(head.schema, /^hbc2js-index\/1$/);
    assert.equal(typeof head.kind, "string");
    assert.equal(typeof head.renderIndependent, "boolean");
  }
});
test("A1b unknown callees carry a reason; known ones don't need one", () => {
  for (const row of jsonl("calls.jsonl").slice(1))
    if (row.callee === "?") assert.equal(typeof row.why, "string");
});
test("A1c ranges are tied to the manifest's render hash", () => {
  const [head] = jsonl("ranges.jsonl");
  assert.equal(head.renderIndependent, false);
  assert.equal(head.renderHash, manifest.render.hash);
});
test("A1d calls rows sorted by (caller, site)", () => {
  const rows = jsonl("calls.jsonl").slice(1);
  const keys = rows.map((r) => [r.caller, r.site]);
  assert.deepEqual(keys, [...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
});
