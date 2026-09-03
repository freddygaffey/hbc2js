// spec 11 §7 step 3 — the `bookmarks` record type (§1.4). One active
// bookmark per target; re-bookmarking supersedes the label rather than
// stacking duplicates (module header, `src/project/bookmarks.ts`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BookmarkStore } from "../../src/project/bookmarks.ts";

function humanProv(who = "analyst@duck.com") {
  return { source: "human" as const, who };
}

test("setBookmark: re-bookmarking the same target supersedes, single active row", () => {
  const store = new BookmarkStore();
  const first = store.setBookmark("fn:42", humanProv(), { label: "revisit sink" });
  const second = store.setBookmark("fn:42", humanProv(), { label: "revisit again" });
  assert.equal(second.superseded?.rid, first.record.rid);
  assert.equal(store.get("fn:42")?.label, "revisit again");
  assert.equal(store.all().filter((r) => r.target === "fn:42").length, 1);
});

test("setBookmark: distinct targets never collide", () => {
  const store = new BookmarkStore();
  store.setBookmark("fn:42", humanProv());
  store.setBookmark("fn:57", humanProv());
  assert.equal(store.all().length, 2);
});

test("BookmarkStore: round-trips through allRecords() -> constructor(records)", () => {
  const store = new BookmarkStore();
  store.setBookmark("fn:42", humanProv(), { label: "revisit" });
  const rows = store.allRecords();
  const reloaded = new BookmarkStore({ records: rows, seq: rows.length });
  assert.deepEqual(reloaded.allRecords(), rows);
});
