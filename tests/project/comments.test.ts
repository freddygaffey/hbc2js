// spec 11 §7 step 3 — the `comments` record type (§1.2). fn-level and
// site-level comments are independent slots; re-commenting the SAME slot
// (same fn, no range; or same fn+range) is append-only-superseding, while a
// new range on the same fn is a NEW slot (module header, `src/project/
// comments.ts`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CommentStore } from "../../src/project/comments.ts";

function humanProv(who = "analyst@duck.com") {
  return { source: "human" as const, who };
}

test("addComment: fn-level comment is pure prose, no evidence required, prov mandatory", () => {
  const store = new CommentStore();
  const { record } = store.addComment("fn:42", "looks fine after review", humanProv());
  assert.equal(record.body, "looks fine after review");
  assert.equal(record.range, undefined);
});

test("addComment: a second fn-level comment on the same fn supersedes the first", () => {
  const store = new CommentStore();
  const first = store.addComment("fn:42", "first note", humanProv());
  const second = store.addComment("fn:42", "revised note", humanProv());
  assert.equal(second.superseded?.rid, first.record.rid);
  assert.deepEqual(
    store.forTarget("fn:42").map((r) => r.body),
    ["revised note"],
  );
});

test("addComment: a site comment at a different line is a NEW slot, does not supersede the fn-level note", () => {
  const store = new CommentStore();
  store.addComment("fn:42", "fn-level note", humanProv());
  store.addComment("fn:42", "site note", humanProv(), { range: { line: 130 } });
  const rows = store.forTarget("fn:42");
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.body).sort(),
    ["fn-level note", "site note"],
  );
});

test("addComment: two site comments at different lines both stay active", () => {
  const store = new CommentStore();
  store.addComment("fn:42", "note at 10", humanProv(), { range: { line: 10 } });
  store.addComment("fn:42", "note at 20", humanProv(), { range: { line: 20 } });
  assert.equal(store.forTarget("fn:42").length, 2);
});

test("addComment: a re-anchored site comment can be flagged rangeStale without being dropped", () => {
  const store = new CommentStore();
  store.addComment("fn:42", "site note", humanProv(), { range: { line: 130 } });
  const revised = store.addComment("fn:42", "site note", humanProv(), { range: { line: 130 }, rangeStale: true });
  assert.equal(revised.record.rangeStale, true);
  assert.equal(store.forTarget("fn:42").length, 1);
});

test("CommentStore: round-trips through allRecords() -> constructor(records)", () => {
  const store = new CommentStore();
  store.addComment("fn:42", "a note", humanProv());
  store.addComment("fn:42", "site note", humanProv(), { range: { line: 5, col: 2 } });
  const rows = store.allRecords();
  const reloaded = new CommentStore({ records: rows, seq: rows.length });
  assert.deepEqual(reloaded.allRecords(), rows);
});
