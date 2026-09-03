// spec 11 §7 step 3 — the `tags` record type (§1.3). `TagStore` wraps
// `RevisionStore<T>` the same way `OverlayStore` does for names; this proves
// its two module-specific rules: (a) different tags on the same target
// coexist (do NOT supersede each other) and (b) re-asserting the SAME tag on
// the same target is append-only-superseding, matching `tag-supersession
// .test.ts` (P3)'s shape for the underlying engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TagStore } from "../../src/project/tags.ts";

function humanProv(who = "analyst@duck.com") {
  return { source: "human" as const, who };
}

test("setTag: different tags on the same target coexist", () => {
  const store = new TagStore();
  store.setTag("reg:42:7", "source", humanProv());
  store.setTag("reg:42:7", "reviewed", humanProv());
  const active = store.getTags("reg:42:7");
  assert.deepEqual(
    active.map((r) => r.tag).sort(),
    ["reviewed", "source"],
  );
});

test("setTag: re-asserting the same tag on the same target supersedes, append-only", () => {
  const store = new TagStore();
  const first = store.setTag("reg:42:7", "suspicious", humanProv());
  const second = store.setTag("reg:42:7", "suspicious", humanProv(), { note: "confirmed via review" });
  assert.equal(second.superseded?.rid, first.record.rid);
  assert.equal(store.getTags("reg:42:7").length, 1);
  assert.equal(store.getTags("reg:42:7")[0]?.note, "confirmed via review");
  const hist = store.history("reg:42:7", "suspicious");
  assert.equal(hist.length, 2);
  assert.equal(hist[0]?.active, true);
  assert.equal(hist[1]?.active, false);
});

test("setTag: revert restores the prior record for that (target,tag) slot", () => {
  const store = new TagStore();
  store.setTag("fn:57", "sink", { source: "tool", who: "reachability-scan", run: "scan-1" });
  store.setTag("fn:57", "sink", humanProv(), { note: "human-confirmed" });
  const reverted = store.revert("fn:57", "sink");
  assert.equal(reverted?.note, undefined);
  assert.equal(reverted?.prov.source, "tool");
});

test("setTag: rejects a tag outside the v1 taxonomy", () => {
  const store = new TagStore();
  assert.throws(() => store.setTag("fn:1", "not-a-real-tag" as never, humanProv()), /unknown tag/);
});

test("TagStore: round-trips through allRecords() -> constructor(records)", () => {
  const store = new TagStore();
  store.setTag("fn:1", "source", humanProv());
  store.setTag("fn:1", "sink", humanProv());
  const rows = store.allRecords();
  const reloaded = new TagStore({ records: rows, seq: rows.length });
  assert.deepEqual(reloaded.allRecords(), rows);
  assert.deepEqual(
    reloaded.getTags("fn:1").map((r) => r.tag).sort(),
    ["sink", "source"],
  );
});
