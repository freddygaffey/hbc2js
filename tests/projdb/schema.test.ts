// tests/projdb/schema.test.ts — spec 16 (docs/specs/16-project-db.md) §7 A1,
// materialised verbatim per the spec's implementer instruction ("A1 ... ships
// here verbatim; the implementer materialises it unchanged as step 0").
// DDL self-consistency on a hand-written sample DB: applies
// `src/projdb/schema.sql` + `tests/projdb/sample/make-sample.sql` with
// `node:sqlite` in the test itself.
//
// Type-only note: `node:sqlite`'s `.get()`/`.all()` return loosely-typed rows
// (`Record<string, SQLOutputValue> | undefined`); this repo's `tsconfig.json`
// runs `strict`+`noUncheckedIndexedAccess`, so each spot the verbatim spec
// text chains a property straight off `.get()`/`.all()` gets a local `as`
// cast below — no assertion, control flow, or SQL changed from the spec.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const ddl = readFileSync(new URL("../../src/projdb/schema.sql", import.meta.url), "utf8");
const sample = readFileSync(new URL("./sample/make-sample.sql", import.meta.url), "utf8");
const db = new DatabaseSync(":memory:");
db.exec(ddl); db.exec(sample);
test("A1a identity pragmas + meta schema row", () => {
  assert.equal((db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id, 0x48425250);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
  assert.equal((db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string }).value, "hbc2js-proj/1");
});
test("A1b append-only triggers fire", () => {
  assert.throws(() => db.exec("UPDATE log SET ts='x' WHERE seq=1"), /E_APPEND_ONLY/);
  assert.throws(() => db.exec("DELETE FROM revisions"), /E_APPEND_ONLY/);
});
test("A1c '?' callee requires why (CHECK)", () => {
  assert.throws(() => db.exec(
    "INSERT INTO ix_calls(caller,site,callee,kind) VALUES (1,99,'?','unknown')"));
});
test("A1d every revision is logged exactly once", () => {
  const r = db.prepare(`SELECT (SELECT COUNT(*) FROM revisions) AS n,
    (SELECT COUNT(DISTINCT rid) FROM log WHERE rid IS NOT NULL) AS m`).get() as { n: number; m: number };
  assert.equal(r.n, r.m);
});
test("A1e json views parse and are sorted", () => {
  const rows = db.prepare("SELECT j, caller, site FROM v_json_calls").all() as
    { j: string; caller: number; site: number }[];
  for (const r of rows) JSON.parse(r.j);
  const keys = rows.map((r) => [r.caller, r.site]);
  assert.deepEqual(keys, [...keys].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!));
});
