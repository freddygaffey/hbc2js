// Overlay store — the pure, bytecode-free half of Design D. Covers spec §11's
// history+revert (5), search (6), and the determinism/no-network guarantee (9)
// at the store level; the gate and render acceptance tests use a real bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OverlayStore, regId } from "../../../src/name-overlay/index.ts";

/** A store with a fixed clock so timestamps (and thus the whole JSON) are
 *  deterministic — no network, no wall-clock (spec §11.9). */
function fixedStore(): OverlayStore {
  const s = new OverlayStore({ bundle: "t.hbc" });
  let n = 0;
  s.now = () => `2026-01-01T00:00:${String(n++).padStart(2, "0")}.000Z`;
  return s;
}

test("setName is append-only: a second name supersedes without loss (spec §11.5)", () => {
  const s = fixedStore();
  const id = regId(2, 7);
  const first = s.setName(id, "userInput", { confidence: "med", evidence: "e1", source: "llm", gate: "passed" });
  const second = s.setName(id, "requestBody", { confidence: "high", evidence: "e2", source: "human", gate: "passed" });
  assert.equal(s.getName(id)!.name, "requestBody");
  assert.equal(second.superseded!.rid, first.record.rid);
  assert.equal(second.record.supersedes, first.record.rid);
  // Nothing destroyed: both are still in history, newest first.
  const h = s.history(id);
  assert.deepEqual(h.map((r) => r.name), ["requestBody", "userInput"]);
  // The append log keeps every record, only one active.
  assert.equal(s.allRecords().filter((r) => r.active).length, 1);
});

test("revert restores the prior name, and clears to rN when none (spec §11.5)", () => {
  const s = fixedStore();
  const id = regId(2, 7);
  s.setName(id, "a", { confidence: "low", evidence: "", source: "llm", gate: "passed" });
  s.setName(id, "b", { confidence: "low", evidence: "", source: "llm", gate: "passed" });
  assert.equal(s.revert(id)!.name, "a"); // b -> a
  assert.equal(s.getName(id)!.name, "a");
  assert.equal(s.revert(id), null); // a -> rN (no prior)
  assert.equal(s.getName(id), null);
  // History is intact after the round trip.
  assert.equal(s.history(id).length, 2);
});

test("revert --to reactivates a specific timestamp", () => {
  const s = fixedStore();
  const id = regId(0, 0);
  const r0 = s.setName(id, "first", { confidence: "low", evidence: "", source: "llm", gate: "passed" });
  s.setName(id, "second", { confidence: "low", evidence: "", source: "llm", gate: "passed" });
  const back = s.revert(id, r0.record.ts);
  assert.equal(back!.name, "first");
  assert.equal(s.getName(id)!.name, "first");
});

test("search filters by confidence/source/gate/fn/text; empty is empty not error (spec §11.6)", () => {
  const s = fixedStore();
  s.setName(regId(42, 1), "userInput", { confidence: "low", evidence: "taint from JSON.parse", source: "llm", gate: "passed" });
  s.setName(regId(42, 2), "counter", { confidence: "high", evidence: "loop index", source: "heuristic", gate: "passed" });
  s.setName(regId(7, 3), "forced", { confidence: "low", evidence: "manual", source: "human", gate: "overridden" });
  assert.deepEqual(s.search({ confidence: "low" }).map((r) => r.name).sort(), ["forced", "userInput"]);
  assert.deepEqual(s.search({ source: "llm" }).map((r) => r.name), ["userInput"]);
  assert.deepEqual(s.search({ gate: "overridden" }).map((r) => r.name), ["forced"]);
  assert.deepEqual(s.search({ fn: 42 }).map((r) => r.name).sort(), ["counter", "userInput"]);
  assert.deepEqual(s.search({ text: "taint" }).map((r) => r.name), ["userInput"]); // matches evidence
  assert.deepEqual(s.search({ text: "COUNT" }).map((r) => r.name), ["counter"]); // case-insensitive on name
  assert.deepEqual(s.search({ fn: 999 }), []); // empty, not an error
});

test("search sees only the active record after a supersede", () => {
  const s = fixedStore();
  const id = regId(1, 1);
  s.setName(id, "old", { confidence: "low", evidence: "", source: "llm", gate: "passed" });
  s.setName(id, "new", { confidence: "low", evidence: "", source: "llm", gate: "passed" });
  assert.deepEqual(s.search({ fn: 1 }).map((r) => r.name), ["new"]);
});

test("the JSON sidecar round-trips and is byte-deterministic (spec §11.9)", () => {
  const dir = mkdtempSync(join(tmpdir(), "overlay-store-"));
  const path = join(dir, "t.hbc.names.json");
  const build = (): OverlayStore => {
    const s = fixedStore();
    s.setName(regId(3, 4), "sink", { confidence: "med", evidence: "flows to eval", source: "llm", gate: "passed" });
    s.setName(regId(3, 4), "evalSink", { confidence: "high", evidence: "confirmed", source: "human", gate: "passed" });
    return s;
  };
  const a = build();
  a.save(path);
  const reloaded = OverlayStore.load(path, "t.hbc");
  assert.equal(reloaded.getName(regId(3, 4))!.name, "evalSink");
  assert.equal(reloaded.history(regId(3, 4)).length, 2);
  // Two identical build+save runs produce identical bytes (no wall clock).
  const path2 = join(dir, "t2.names.json");
  build().save(path2);
  assert.equal(readFileSync(path, "utf8"), readFileSync(path2, "utf8"));
});

test("a missing sidecar loads as an empty store, not an error", () => {
  const s = OverlayStore.load(join(tmpdir(), "does-not-exist-" + Math.random(), "x.json"), "t.hbc");
  assert.equal(s.getName(regId(0, 0)), null);
  assert.deepEqual(s.search({}), []);
});
