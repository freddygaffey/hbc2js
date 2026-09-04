// tests/projdb/status-adopt.test.ts — docs/specs/18-project-storage-
// integrity.md §10 (three-way conflict porcelain) / §R4 step 3 acceptance:
// `status` classifies every shard clean/lag/hand-edit/conflict; `adopt`
// folds a validated hand edit into the db exactly like an MCP write (new
// revision + chained log entry + re-locked shard) and rejects an invalid
// one (a finding whose evidence no longer resolves); `restore` discards a
// hand edit and re-materialises the shard from the db. Also the §R4 step 3
// folded-in fix: `verify --full`'s `dbShardsAgree`/`roundTrip` no longer
// false-positive after incremental (write-path) exports have left shards
// at differing `stateBinding.dbVersion`s — a uniform bulk re-export used to
// blind-diff raw bytes against them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbGetName, dbSetFinding, dbSetName, dbSetTag } from "../../src/projdb/annotations.ts";
import { exportWriteEffect } from "../../src/projdb/export.ts";
import { verifyProject } from "../../src/projdb/verify.ts";
import { adoptShard, allShardPaths, classifyThreeWay, diffShard, restoreShard } from "../../src/projdb/threeway.ts";

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
  return mkdtempSync(join(tmpdir(), "hbc2js-status-adopt-"));
}

function statusOf(dir: string, db: DatabaseSync, path: string): string {
  const found = classifyThreeWay(db, dir).find((s) => s.path === path);
  assert.ok(found, `no shard classified at ${path}`);
  return found.status;
}

test("status: a freshly-written shard is clean", () => {
  const db = freshDb();
  const dir = tmpProjectDir();
  const r = dbSetName(db, "fn:1", "decodePayload", humanProv());
  exportWriteEffect(db, dir, Number(r.record.rid));
  const path = join(dir, "analysis", "names", "_unassigned.json");
  assert.equal(statusOf(dir, db, path), "clean");
});

test("status: an unrelated write elsewhere leaves this shard's own content unchanged but classifies it lag (fast per-shard path, step 1)", () => {
  const db = freshDb();
  const dir = tmpProjectDir();
  const r1 = dbSetName(db, "fn:1", "decodePayload", humanProv());
  exportWriteEffect(db, dir, Number(r1.record.rid));
  const namesPath = join(dir, "analysis", "names", "_unassigned.json");
  assert.equal(statusOf(dir, db, namesPath), "clean");
  const r2 = dbSetTag(db, "fn:2", "reviewed", humanProv());
  exportWriteEffect(db, dir, Number(r2.record.rid));
  assert.equal(statusOf(dir, db, namesPath), "lag");
});

test("status: a hand-edited-but-otherwise-caught-up shard is hand-edit", () => {
  const db = freshDb();
  const dir = tmpProjectDir();
  const r = dbSetName(db, "fn:1", "decodePayload", humanProv());
  exportWriteEffect(db, dir, Number(r.record.rid));
  const path = join(dir, "analysis", "names", "_unassigned.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, { name: string }> };
  parsed.entries["fn:1"]!.name = "handEditedName";
  writeFileSync(path, JSON.stringify(parsed), "utf8");
  assert.equal(statusOf(dir, db, path), "hand-edit");
});

test("status: a hand edit made BEFORE a later, unrelated db write is conflict (both halves diverged since base)", () => {
  const db = freshDb();
  const dir = tmpProjectDir();
  const r1 = dbSetName(db, "fn:1", "decodePayload", humanProv());
  exportWriteEffect(db, dir, Number(r1.record.rid));
  const path = join(dir, "analysis", "names", "_unassigned.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, { name: string }> };
  parsed.entries["fn:1"]!.name = "handEditedName";
  writeFileSync(path, JSON.stringify(parsed), "utf8"); // hand-edit, db unchanged since -> still hand-edit
  assert.equal(statusOf(dir, db, path), "hand-edit");
  const r2 = dbSetTag(db, "fn:2", "reviewed", humanProv()); // db moves on elsewhere
  exportWriteEffect(db, dir, Number(r2.record.rid));
  assert.equal(statusOf(dir, db, path), "conflict");
});

test("diff: shows the hand-edited value vs. what the db currently holds", () => {
  const db = freshDb();
  const dir = tmpProjectDir();
  const r = dbSetName(db, "fn:1", "decodePayload", humanProv());
  exportWriteEffect(db, dir, Number(r.record.rid));
  const path = join(dir, "analysis", "names", "_unassigned.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, { name: string }> };
  parsed.entries["fn:1"]!.name = "handEditedName";
  writeFileSync(path, JSON.stringify(parsed), "utf8");
  const out = diffShard(db, path);
  assert.match(out, /handEditedName/);
  assert.match(out, /decodePayload/);
});

test("adopt: folds a valid hand edit into the db — authoritative, logged, and re-locked, exactly like an MCP write", () => {
  const db = freshDb();
  const dir = tmpProjectDir();
  const r = dbSetName(db, "fn:1", "decodePayload", humanProv());
  exportWriteEffect(db, dir, Number(r.record.rid));
  const path = join(dir, "analysis", "names", "_unassigned.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, { name: string }> };
  parsed.entries["fn:1"]!.name = "handEditedName";
  writeFileSync(path, JSON.stringify(parsed), "utf8");
  assert.equal(statusOf(dir, db, path), "hand-edit");

  const logRowsBefore = (db.prepare(`SELECT COUNT(*) AS n FROM log`).get() as { n: number }).n;
  const result = adoptShard(db, dir, path, humanProv("alice"));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.rids?.length, 1);

  // Authoritative: the db's active name for fn:1 is now the hand-edited
  // value — the SAME effect `dbSetName` (an MCP write) would have.
  const active = dbGetName(db, "fn:1");
  assert.equal(active?.value.name, "handEditedName");
  assert.equal(active?.prov.who, "alice");

  // Logged: exactly one new chained log row minted for the fold-in.
  const logRowsAfter = (db.prepare(`SELECT COUNT(*) AS n FROM log`).get() as { n: number }).n;
  assert.equal(logRowsAfter, logRowsBefore + 1);

  // Re-locked: the file on disk is now self-consistent and caught up —
  // adopt leaves the shard clean, not still flagged hand-edit.
  assert.equal(statusOf(dir, db, path), "clean");
  const reWritten = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, { name: string }> };
  assert.equal(reWritten.entries["fn:1"]!.name, "handEditedName");
});

test("adopt: rejects a conflicted shard without --force", () => {
  const db = freshDb();
  const dir = tmpProjectDir();
  const r1 = dbSetName(db, "fn:1", "decodePayload", humanProv());
  exportWriteEffect(db, dir, Number(r1.record.rid));
  const path = join(dir, "analysis", "names", "_unassigned.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, { name: string }> };
  parsed.entries["fn:1"]!.name = "handEditedName";
  writeFileSync(path, JSON.stringify(parsed), "utf8");
  const r2 = dbSetTag(db, "fn:2", "reviewed", humanProv());
  exportWriteEffect(db, dir, Number(r2.record.rid));
  assert.equal(statusOf(dir, db, path), "conflict");

  const result = adoptShard(db, dir, path, humanProv());
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /conflict/);
});

test("adopt: rejects a findings shard whose evidence no longer resolves against the project's index (spec 11 §4.1)", () => {
  const db = freshDb();
  const dir = tmpProjectDir();
  db.prepare(`INSERT INTO ix_functions (fn, name, params, module, parent, kind, offset, size) VALUES (1, 'foo', 0, NULL, NULL, 'normal', 0, 10)`).run();
  const { record } = dbSetFinding(
    db,
    "fn:1",
    { findingNo: 1, severity: "medium", status: "open", claim: "unvalidated input", evidence: [{ ref: "reg:1:3", role: "source" }] },
    humanProv(),
  );
  exportWriteEffect(db, dir, Number(record.rid));
  const findingsDir = join(dir, "analysis", "findings");
  const files = readdirSync(findingsDir);
  assert.equal(files.length, 1);
  const path = join(findingsDir, files[0]!);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { evidence: { ref: string; role: string }[]; claim: string };
  // A hand edit that swaps the evidence to reference a function that does
  // NOT exist in this project's index — this must never be foldable.
  parsed.evidence = [{ ref: "reg:99:0", role: "source" }];
  parsed.claim = "hand-edited claim";
  writeFileSync(path, JSON.stringify(parsed), "utf8");

  const before = db.prepare(`SELECT COUNT(*) AS n FROM revisions`).get() as { n: number };
  const result = adoptShard(db, dir, path, humanProv());
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /evidence no longer resolves/);
  // Rejected atomically: no db write happened at all.
  const after = db.prepare(`SELECT COUNT(*) AS n FROM revisions`).get() as { n: number };
  assert.equal(after.n, before.n);
});

test("adopt: rejects a malformed (structurally broken) hand-edited shard", () => {
  const db = freshDb();
  const dir = tmpProjectDir();
  const r = dbSetName(db, "fn:1", "decodePayload", humanProv());
  exportWriteEffect(db, dir, Number(r.record.rid));
  const path = join(dir, "analysis", "names", "_unassigned.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  (parsed.entries as Record<string, unknown>)["fn:1"] = { name: 12345 }; // not a string
  writeFileSync(path, JSON.stringify(parsed), "utf8");
  const result = adoptShard(db, dir, path, humanProv());
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /malformed/);
});

test("restore: discards a hand edit and re-materialises the shard from the db, never touching an unrelated shard's own pending edit", () => {
  const db = freshDb();
  const dir = tmpProjectDir();
  const r1 = dbSetName(db, "fn:1", "decodePayload", humanProv());
  exportWriteEffect(db, dir, Number(r1.record.rid));
  const r2 = dbSetTag(db, "fn:2", "reviewed", humanProv());
  exportWriteEffect(db, dir, Number(r2.record.rid));

  const namesPath = join(dir, "analysis", "names", "_unassigned.json");
  const annPath = join(dir, "analysis", "annotations", "_unassigned.json");
  const namesParsed = JSON.parse(readFileSync(namesPath, "utf8")) as { entries: Record<string, { name: string }> };
  namesParsed.entries["fn:1"]!.name = "badHandEdit";
  writeFileSync(namesPath, JSON.stringify(namesParsed), "utf8");
  const annBefore = readFileSync(annPath, "utf8");
  const annParsed = JSON.parse(annBefore) as Record<string, unknown>;
  (annParsed as { tags: unknown[] }).tags = []; // an UNRELATED pending hand edit
  writeFileSync(annPath, JSON.stringify(annParsed), "utf8");

  const result = restoreShard(db, dir, namesPath);
  assert.equal(result.restored, true);
  const restored = JSON.parse(readFileSync(namesPath, "utf8")) as { entries: Record<string, { name: string }> };
  assert.equal(restored.entries["fn:1"]!.name, "decodePayload");
  assert.equal(statusOf(dir, db, namesPath), "clean");

  // The OTHER shard's own pending hand edit must be untouched (§8's "never
  // silently overwrite a hand edit" guard — restoring one shard is
  // surgical, not a bulk re-export).
  assert.equal(readFileSync(annPath, "utf8"), JSON.stringify(annParsed));
});

test("adopt/restore --all targets: allShardPaths lists every analysis/ shard", () => {
  const db = freshDb();
  const dir = tmpProjectDir();
  const r1 = dbSetName(db, "fn:1", "decodePayload", humanProv());
  exportWriteEffect(db, dir, Number(r1.record.rid));
  const r2 = dbSetTag(db, "fn:2", "reviewed", humanProv());
  exportWriteEffect(db, dir, Number(r2.record.rid));
  const paths = allShardPaths(dir);
  assert.equal(paths.length, 2);
  assert.ok(paths.some((p) => p.includes("names")));
  assert.ok(paths.some((p) => p.includes("annotations")));
});

// --- the §R4 step 3 folded-in fix: verify --full after incremental writes ---

test("verify --full: dbShardsAgree and roundTrip no longer false-positive after incremental (write-path) exports leave shards at differing stateBinding.dbVersions", () => {
  const db = freshDb();
  const dir = tmpProjectDir();
  // Two writes touching DIFFERENT shards: the first shard's stateBinding
  // is now behind the second write's — a uniform bulk re-export used to
  // stamp every shard with the CURRENT dbVersion and blind-diff raw bytes,
  // producing a false "content differs" purely from that stamp drift.
  const r1 = dbSetName(db, "fn:1", "decodePayload", humanProv());
  exportWriteEffect(db, dir, Number(r1.record.rid));
  const r2 = dbSetTag(db, "fn:2", "reviewed", humanProv());
  exportWriteEffect(db, dir, Number(r2.record.rid));

  const result = verifyProject(db, dir, { full: true });
  assert.equal(result.full?.dbShardsAgree, true, result.full?.detail.join("\n"));
  assert.equal(result.full?.roundTrip, true, result.full?.detail.join("\n"));
  assert.equal(result.ok, true);
  // The fast per-shard path still correctly reports the untouched shard as
  // lagging — this fix is about the deep validators' false POSITIVE, not
  // about hiding a real lag classification.
  const namesPath = join(dir, "analysis", "names", "_unassigned.json");
  assert.equal(statusOf(dir, db, namesPath), "lag");
});

test("verify --full: a GENUINE db-vs-shard divergence (a real hand edit) is still caught, not masked by the lag-aware compare", () => {
  const db = freshDb();
  const dir = tmpProjectDir();
  const r = dbSetName(db, "fn:1", "decodePayload", humanProv());
  exportWriteEffect(db, dir, Number(r.record.rid));
  const path = join(dir, "analysis", "names", "_unassigned.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, { name: string }> };
  parsed.entries["fn:1"]!.name = "handEditedName";
  writeFileSync(path, JSON.stringify(parsed), "utf8");

  const result = verifyProject(db, dir, { full: true });
  assert.equal(result.full?.dbShardsAgree, false);
  assert.equal(result.ok, false);
});

test("all fixtures exist on disk (sanity: mkdtempSync produced real dirs)", () => {
  const dir = tmpProjectDir();
  assert.ok(existsSync(dir));
});
