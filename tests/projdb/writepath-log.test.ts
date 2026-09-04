// tests/projdb/writepath-log.test.ts — docs/specs/18-project-storage-
// integrity.md §6 step 3 / §R4 step 2 acceptance: the LIVE write path
// (`src/projdb/export.ts`'s `exportWriteEffect`, hooked from every
// DB-backed `ProjectService` write verb, `src/project/service.ts`) appends
// a TRUE per-write chained `log/` entry — carrying the write's own value —
// instead of only the step-0/1 one-shot bulk export. Closes the
// historical-value-recovery gap `rebuild.ts`'s module header names: after a
// supersede/revert, `rebuild` now reconstructs the superseded/reactivated
// history from `log/` alone, not inert placeholders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbGetName, dbRevertName, dbSetName, nameAdapter } from "../../src/projdb/annotations.ts";
import { exportWriteEffect, sha256Hex, canonicalJson } from "../../src/projdb/export.ts";
import { rebuildProject } from "../../src/projdb/rebuild.ts";
import { verifyProject } from "../../src/projdb/verify.ts";
import { DbRevisionStore } from "../../src/projdb/revision-store.ts";

const ddl = readFileSync(new URL("../../src/projdb/schema.sql", import.meta.url), "utf8");

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  return db;
}

function humanProv(who = "fred") {
  return { source: "human" as const, who };
}

function tmpProjectDir(): string {
  return mkdtempSync(join(tmpdir(), "hbc2js-writepath-"));
}

/** The rid `revision-store.ts`'s `revert()` just minted for its OWN
 *  bookkeeping row — `revert()`'s return value is the REACTIVATED record
 *  (its ORIGINAL rid), not the fresh bookkeeping row, so a live caller that
 *  needs to export THIS write (as `ProjectService`'s hook would, once it
 *  grows a revert verb — none exists yet, docs/BUGS.md) reads it back the
 *  same way `log`'s own `seq` is defined: the table's high-water mark,
 *  right after the revert's own transaction committed. */
function lastRid(db: DatabaseSync): number {
  return (db.prepare(`SELECT MAX(rid) AS rid FROM log`).get() as { rid: number }).rid;
}

function collectLogEntries(dir: string): Record<string, unknown>[] {
  const logDir = join(dir, "log");
  if (!existsSync(logDir)) return [];
  const out: Record<string, unknown>[] = [];
  for (const f of readdirSync(logDir).filter((f) => f.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(logDir, f), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}

test("a live write sequence (set, supersede, revert) appends exactly one chained log entry per write, with correct shard ids + hashes", () => {
  const db = freshDb();
  const dir = tmpProjectDir();
  try {
    const r1 = dbSetName(db, "fn:1", "decodePayload", humanProv(), { ts: "2026-09-04T00:00:01.000Z" });
    const w1 = exportWriteEffect(db, dir, Number(r1.record.rid));
    assert.equal(w1.shards.length, 1);
    assert.equal(w1.shards[0]?.path, "names/_unassigned");

    const r2 = dbSetName(db, "fn:1", "decodePayloadV2", humanProv(), { ts: "2026-09-04T00:00:02.000Z" }); // supersede
    const w2 = exportWriteEffect(db, dir, Number(r2.record.rid));
    assert.equal(w2.shards.length, 1);
    assert.notEqual(w2.shards[0]?.contentHash, w1.shards[0]?.contentHash, "supersede changed the shard's active content");

    dbRevertName(db, "fn:1", humanProv()); // reactivates r1 ("decodePayload")
    const revertRid = lastRid(db);
    const w3 = exportWriteEffect(db, dir, revertRid);
    assert.equal(w3.shards.length, 1, "a revert that reactivates a prior value re-materialises its module shard");

    // Exactly one log entry per write, in rid order, correctly chained.
    const entries = collectLogEntries(dir);
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((e) => e.seq), [Number(r1.record.rid), Number(r2.record.rid), revertRid]);
    assert.equal(entries[0]?.prevHash, "genesis");
    for (let i = 1; i < entries.length; i++) {
      assert.equal(entries[i]?.prevHash, entries[i - 1]?.hash, `entry ${i}'s prevHash chains from entry ${i - 1}'s hash`);
    }
    // Every entry's own hash is a genuine recompute over its own content.
    for (const e of entries) {
      const { hash, ...rest } = e;
      assert.equal(sha256Hex(canonicalJson(rest)), hash, "entry hash matches recompute");
    }
    // The 'annotate' entries carry the write's own value (§R4 step 2's
    // history-recovery fix); the 'revert' entry carries what it reactivated.
    assert.equal((entries[0] as { value?: { name?: string } }).value?.name, "decodePayload");
    assert.equal((entries[1] as { value?: { name?: string } }).value?.name, "decodePayloadV2");
    assert.equal(entries[2]?.op, "revert");
    assert.equal(entries[2]?.reactivates, String(r1.record.rid));

    // §8: verify stays green after live writes — every shard is
    // self-consistent (ok or lag, never hand-edit) and the chain holds.
    const result = verifyProject(db, dir);
    assert.equal(result.ok, true);
    for (const s of result.shards) assert.ok(s.status === "ok" || s.status === "lag", `${s.path}: ${s.status} ${s.detail ?? ""}`);
    for (const c of result.logChain) assert.equal(c.ok, true, c.detail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuild after a supersede reconstructs the superseded history from live-written log/ (not step-0/1 placeholders)", () => {
  const db = freshDb();
  const dir = tmpProjectDir();
  try {
    const r1 = dbSetName(db, "fn:2", "alpha", humanProv(), { ts: "2026-09-04T00:00:01.000Z" });
    exportWriteEffect(db, dir, Number(r1.record.rid));
    const r2 = dbSetName(db, "fn:2", "beta", humanProv(), { ts: "2026-09-04T00:00:02.000Z" }); // supersede
    exportWriteEffect(db, dir, Number(r2.record.rid));

    // cache.db is gone; only analysis/+log/ survive (§8 recovery).
    const fresh = freshDb();
    const result = rebuildProject(fresh, dir);
    assert.deepEqual(result.warnings, []);

    assert.equal(dbGetName(fresh, "fn:2")?.value.name, "beta"); // the live head

    const history = new DbRevisionStore(fresh, nameAdapter).history("name:fn:2");
    assert.equal(history.length, 2, "both the active AND the superseded write are reconstructed with real content");
    const beta = history.find((h) => h.value.name === "beta");
    const alpha = history.find((h) => h.value.name === "alpha");
    assert.ok(beta !== undefined && alpha !== undefined, "the superseded write's real value ('alpha') survived rebuild — not an inert placeholder");
    assert.equal(beta?.active, true);
    assert.equal(alpha?.active, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuild after a revert-that-reactivates restores the prior value, not a clear", () => {
  const db = freshDb();
  const dir = tmpProjectDir();
  try {
    const r1 = dbSetName(db, "fn:3", "v1", humanProv(), { ts: "2026-09-04T00:00:01.000Z" });
    exportWriteEffect(db, dir, Number(r1.record.rid));
    const r2 = dbSetName(db, "fn:3", "v2", humanProv(), { ts: "2026-09-04T00:00:02.000Z" });
    exportWriteEffect(db, dir, Number(r2.record.rid));
    dbRevertName(db, "fn:3", humanProv());
    exportWriteEffect(db, dir, lastRid(db));

    assert.equal(dbGetName(db, "fn:3")?.value.name, "v1", "sanity: the live DB reactivated v1");

    const fresh = freshDb();
    const result = rebuildProject(fresh, dir);
    assert.deepEqual(result.warnings, []);
    assert.equal(dbGetName(fresh, "fn:3")?.value.name, "v1", "rebuild reproduces the reactivation, not a cleared slot");

    const history = new DbRevisionStore(fresh, nameAdapter).history("name:fn:3");
    assert.equal(history.length, 2);
    assert.equal(history.find((h) => h.value.name === "v1")?.active, true);
    assert.equal(history.find((h) => h.value.name === "v2")?.active, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
