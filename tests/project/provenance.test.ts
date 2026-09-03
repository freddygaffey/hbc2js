// A-PROV (spec 11 §6/§7 step 3): "a write with no `prov` is rejected; a
// mechanical `provably-dead` tag is stamped `source:"tool"`." Exercised
// against all three record-type modules this step ships (findings, step 4,
// get their own A-STATUS/A-PROV coverage there) plus `schema.ts`'s shared
// `assertProvenance`/`assertEnvelope` (the on-disk half of the same rule).
import { test } from "node:test";
import assert from "node:assert/strict";
import { TagStore } from "../../src/project/tags.ts";
import { BookmarkStore } from "../../src/project/bookmarks.ts";
import { CommentStore } from "../../src/project/comments.ts";
import { assertProvenance, assertEnvelope } from "../../src/project/schema.ts";

const validHuman = { source: "human" as const, who: "analyst@duck.com" };

test("setTag rejects a write with no prov", () => {
  const store = new TagStore();
  assert.throws(() => store.setTag("fn:1", "source", undefined as never), /prov is required/);
  assert.throws(() => store.setTag("fn:1", "source", {} as never), /prov\.source must be/);
  assert.throws(() => store.setTag("fn:1", "source", { source: "human" } as never), /prov\.who must be/);
});

test("setBookmark rejects a write with no prov", () => {
  const store = new BookmarkStore();
  assert.throws(() => store.setBookmark("fn:1", null as never), /prov is required/);
});

test("addComment rejects a write with no prov", () => {
  const store = new CommentStore();
  assert.throws(() => store.addComment("fn:1", "note", { source: "bogus", who: "x" } as never), /prov\.source must be human\|llm\|tool/);
});

test("valid prov is accepted on all three record types", () => {
  const tags = new TagStore();
  const bookmarks = new BookmarkStore();
  const comments = new CommentStore();
  assert.doesNotThrow(() => tags.setTag("fn:1", "source", validHuman));
  assert.doesNotThrow(() => bookmarks.setBookmark("fn:1", validHuman));
  assert.doesNotThrow(() => comments.addComment("fn:1", "note", validHuman));
});

test("a mechanical tag proposal is stamped source:\"tool\" and distinguishable from a human one (§4.2)", () => {
  const store = new TagStore();
  const mechanical = store.setTag("fn:1", "provably-dead", { source: "tool", who: "reachability-scan", run: "scan-2026-09-03" });
  assert.equal(mechanical.record.prov.source, "tool");
  assert.equal(mechanical.record.prov.run, "scan-2026-09-03");
  const human = store.setTag("fn:2", "reviewed", validHuman);
  assert.equal(human.record.prov.source, "human");
  assert.equal(human.record.prov.run, undefined);
});

test("assertProvenance/assertEnvelope: the on-disk validator applies the identical rule", () => {
  assert.throws(() => assertProvenance(undefined, "test"), /prov is required/);
  assert.throws(() => assertProvenance({ source: "human" }, "test"), /prov\.who must be/);
  assert.doesNotThrow(() => assertProvenance({ source: "llm", who: "run-1", run: "run-1" }, "test"));
  const row = { rid: "1", kind: "tag", target: "fn:1", ts: "2026-01-01T00:00:00.000Z", supersedes: null, active: true, ctx: {}, prov: {} };
  assert.throws(() => assertEnvelope(row, "test"), /prov\.source must be/);
});
