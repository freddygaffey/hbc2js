// tests/projdb/export.test.ts — docs/specs/18-project-storage-integrity.md
// §6 step 3 / §9 `export` / §R4 step 0 acceptance: `hbcproj export`
// materialises `analysis/` + `log/` shards from a `.hbcproj` DB with a few
// annotations/findings — expected shard files exist with content-hash ids
// (§7); re-export of unchanged state is byte-identical (§14 "re-export is a
// no-op"); a finding's id is stable across a status transition (id hashes
// only its immutable defining fields, §7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbAddComment, dbSetBookmark, dbSetFinding, dbSetName, dbSetTag } from "../../src/projdb/annotations.ts";
import { exportProject, findingContentId } from "../../src/projdb/export.ts";

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
  return mkdtempSync(join(tmpdir(), "hbc2js-export-"));
}

function seed(db: DatabaseSync): void {
  dbSetName(db, "fn:1", "decodePayload", humanProv(), { ts: "2026-09-04T00:00:01.000Z" });
  dbSetName(db, "fn:2", "encodePayload", humanProv(), { ts: "2026-09-04T00:00:02.000Z" });
  dbSetTag(db, "fn:1", "reviewed", humanProv(), { ts: "2026-09-04T00:00:03.000Z" });
  dbAddComment(db, "fn:1", "looks fine", humanProv(), { ts: "2026-09-04T00:00:04.000Z" });
  dbSetBookmark(db, "fn:2", humanProv(), { ts: "2026-09-04T00:00:05.000Z", label: "revisit" });
  dbSetFinding(
    db,
    "fn:1",
    { findingNo: 1, severity: "medium", status: "open", claim: "unvalidated input", evidence: [{ ref: "reg:1:3", role: "source" }] },
    humanProv(),
    { ts: "2026-09-04T00:00:06.000Z" },
  );
}

test("export materialises names/annotations/findings shards with content-hash ids", () => {
  const db = freshDb();
  seed(db);
  const dir = tmpProjectDir();
  try {
    const result = exportProject(db, dir);
    assert.ok(result.written.length > 0, "first export must write shards");
    assert.equal(result.unchanged.length, 0, "nothing exists yet, nothing can be unchanged");

    const namesDir = join(dir, "analysis", "names");
    const annDir = join(dir, "analysis", "annotations");
    const findingsDir = join(dir, "analysis", "findings");
    assert.ok(existsSync(namesDir));
    assert.ok(existsSync(annDir));
    assert.ok(existsSync(findingsDir));

    // names sharded per (unassigned, since no ix_functions rows) module
    const nameFiles = readdirSync(namesDir);
    assert.equal(nameFiles.length, 1);
    const namesShard = JSON.parse(readFileSync(join(namesDir, nameFiles[0]!), "utf8"));
    assert.equal(namesShard.entries["fn:1"].name, "decodePayload");
    assert.equal(namesShard.entries["fn:2"].name, "encodePayload");
    assert.equal(typeof namesShard.contentHash, "string");
    assert.equal(namesShard.stateBinding.dbVersion > 0, true);

    // findings: one file, named by the content-hash id
    const findingFiles = readdirSync(findingsDir);
    assert.equal(findingFiles.length, 1);
    const expectedId = findingContentId("fn:1", [{ ref: "reg:1:3", role: "source" }]);
    assert.equal(findingFiles[0], `${expectedId}.json`);
    const findingShard = JSON.parse(readFileSync(join(findingsDir, findingFiles[0]!), "utf8"));
    assert.equal(findingShard.id, expectedId);
    assert.equal(findingShard.status, "open");

    // annotations: one shard carrying the tag/comment/bookmark
    const annFiles = readdirSync(annDir);
    assert.equal(annFiles.length, 1);
    const annShard = JSON.parse(readFileSync(join(annDir, annFiles[0]!), "utf8"));
    assert.equal(annShard.tags.length, 1);
    assert.equal(annShard.comments.length, 1);
    assert.equal(annShard.bookmarks.length, 1);

    // log/: one day file, day-sharded
    const logDir = join(dir, "log");
    assert.ok(existsSync(logDir));
    const logFiles = readdirSync(logDir);
    assert.equal(logFiles.length, 1);
    assert.equal(logFiles[0], "2026-09-04.jsonl");
    const logLines = readFileSync(join(logDir, logFiles[0]!), "utf8").trim().split("\n");
    assert.equal(logLines.length, 6); // one log row per seeded write
    const firstEntry = JSON.parse(logLines[0]!);
    assert.equal(firstEntry.prevHash, "genesis");
    const secondEntry = JSON.parse(logLines[1]!);
    assert.equal(secondEntry.prevHash, firstEntry.hash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-export of unchanged DB state is byte-identical (a no-op)", () => {
  const db = freshDb();
  seed(db);
  const dir = tmpProjectDir();
  try {
    const first = exportProject(db, dir);
    assert.ok(first.written.length > 0);

    const before = new Map<string, string>();
    for (const f of walk(dir)) before.set(f, readFileSync(f, "utf8"));

    const second = exportProject(db, dir);
    assert.equal(second.written.length, 0, "no DB change since last export -> nothing should be (re)written");
    assert.equal(second.unchanged.length, first.written.length, "every previously-written shard must come back unchanged");

    for (const f of walk(dir)) assert.equal(readFileSync(f, "utf8"), before.get(f), `${f} must be byte-identical after a no-op re-export`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a finding's exported id is stable across a status transition", () => {
  const db = freshDb();
  const target = "fn:7";
  const evidence = [{ ref: "reg:7:0", role: "source" }];
  dbSetFinding(db, target, { findingNo: 1, severity: "high", status: "open", claim: "sink reached", evidence }, humanProv(), { ts: "2026-09-04T01:00:00.000Z" });
  const dir = tmpProjectDir();
  try {
    const before = exportProject(db, dir);
    const idBefore = findingContentId(target, evidence);
    assert.ok(before.written.some((p) => p.endsWith(`${idBefore}.json`)));

    // status transition — a superseding write with the SAME target/evidence,
    // different status/claim: the id must not change (§7).
    dbSetFinding(db, target, { findingNo: 1, severity: "high", status: "confirmed", claim: "sink reached, confirmed", evidence }, humanProv(), { ts: "2026-09-04T01:01:00.000Z" });
    const after = exportProject(db, dir);
    const idAfter = findingContentId(target, evidence);
    assert.equal(idBefore, idAfter);
    assert.ok(after.written.some((p) => p.endsWith(`${idAfter}.json`)), "the same shard file must be rewritten with the new status");

    const findingsDir = join(dir, "analysis", "findings");
    const files = readdirSync(findingsDir);
    assert.equal(files.length, 1, "status transition must update the SAME shard file, not create a new one");
    const shard = JSON.parse(readFileSync(join(findingsDir, files[0]!), "utf8"));
    assert.equal(shard.status, "confirmed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
