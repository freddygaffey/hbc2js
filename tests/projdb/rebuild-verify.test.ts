// tests/projdb/rebuild-verify.test.ts — docs/specs/18-project-storage-
// integrity.md §6 step 1 / §8 (amended) / §R3 metric 1 / §R4 step 1
// acceptance: `rebuild` regenerates a fresh DB from hash-verified JSON
// (recovery direction) and round-trips byte-identically back through
// `export`; `verify` distinguishes a clean project from a corrupted shard
// hash, a broken log chain, and a hand-edited shard (never mistaken for
// lag — the §8 amendment this spec exists to fix, R1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbAddComment, dbGetName, dbGetTags, dbRevertBookmark, dbSetBookmark, dbSetFinding, dbSetName, dbSetTag } from "../../src/projdb/annotations.ts";
import { exportProject } from "../../src/projdb/export.ts";
import { rebuildProject } from "../../src/projdb/rebuild.ts";
import { verifyProject } from "../../src/projdb/verify.ts";

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
  return mkdtempSync(join(tmpdir(), "hbc2js-rebuild-verify-"));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Seeds every record kind, including a superseding write (a name overwrite)
 *  and a revert, so the log carries 'annotate' AND 'revert' ops across
 *  multiple kinds — the "writes across all record types" of R3 metric 1. */
function seedRich(db: DatabaseSync): void {
  dbSetName(db, "fn:1", "decodePayload", humanProv(), { ts: "2026-09-04T00:00:01.000Z" });
  dbSetName(db, "fn:1", "decodePayloadV2", humanProv(), { ts: "2026-09-04T00:00:02.000Z" }); // supersede
  dbSetName(db, "fn:2", "encodePayload", humanProv(), { ts: "2026-09-04T00:00:03.000Z" });
  dbSetTag(db, "fn:1", "reviewed", humanProv(), { ts: "2026-09-04T00:00:04.000Z" });
  dbSetTag(db, "fn:1", "hot-path", humanProv(), { ts: "2026-09-04T00:00:05.000Z" });
  dbAddComment(db, "fn:1", "looks fine", humanProv(), { ts: "2026-09-04T00:00:06.000Z" });
  dbSetBookmark(db, "fn:2", humanProv(), { ts: "2026-09-04T00:00:07.000Z", label: "revisit" });
  dbSetFinding(
    db,
    "fn:1",
    { findingNo: 1, severity: "medium", status: "open", claim: "unvalidated input", evidence: [{ ref: "reg:1:3", role: "source" }] },
    humanProv(),
    { ts: "2026-09-04T00:00:08.000Z" },
  );
  dbSetBookmark(db, "fn:3", humanProv(), { ts: "2026-09-04T00:00:09.000Z" });
  dbRevertBookmark(db, "fn:3", humanProv()); // exercises the log's 'revert' op path
}

function contentOf(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of walk(dir)) out.set(f.slice(dir.length), readFileSync(f, "utf8"));
  return out;
}

test("rebuild regenerates a fresh DB from analysis/+log/ and round-trips byte-identically (§R3 metric 1)", () => {
  const db = freshDb();
  seedRich(db);
  const dir = tmpProjectDir();
  try {
    exportProject(db, dir);
    const before = contentOf(dir);
    assert.ok(before.size > 0);

    // The recovery scenario (§8): cache.db is gone; only analysis/+log/
    // survive. Rebuild into a brand-new, empty DB.
    const fresh = freshDb();
    const result = rebuildProject(fresh, dir);
    assert.ok(result.activeWritten > 0);
    assert.ok(result.logEntriesWritten > 0);
    assert.deepEqual(result.warnings, []);

    // The rebuilt DB is genuinely queryable, not just export-shaped.
    const name = dbGetName(fresh, "fn:1");
    assert.equal(name?.value.name, "decodePayloadV2"); // the superseding write won
    const tags = dbGetTags(fresh, "fn:1").map((t) => t.value.tag).sort();
    assert.deepEqual(tags, ["hot-path", "reviewed"]);

    // rebuild -> export reproduces the ORIGINAL shards byte-for-byte.
    const dir2 = tmpProjectDir();
    try {
      exportProject(fresh, dir2);
      const after = contentOf(dir2);
      assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), "same shard set");
      for (const [rel, text] of before) assert.equal(after.get(rel), text, `${rel} must round-trip byte-identically`);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify passes cleanly on a freshly exported project", () => {
  const db = freshDb();
  seedRich(db);
  const dir = tmpProjectDir();
  try {
    exportProject(db, dir);
    const result = verifyProject(db, dir);
    assert.equal(result.ok, true);
    assert.ok(result.shards.length > 0);
    for (const s of result.shards) assert.equal(s.status, "ok", `${s.path}: ${s.detail ?? ""}`);
    for (const c of result.logChain) assert.equal(c.ok, true, c.detail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify --full proves round-trip + DB<->shards agreement on a clean project", () => {
  const db = freshDb();
  seedRich(db);
  const dir = tmpProjectDir();
  try {
    exportProject(db, dir);
    const result = verifyProject(db, dir, { full: true });
    assert.equal(result.ok, true);
    assert.ok(result.full !== undefined);
    assert.equal(result.full?.roundTrip, true, result.full?.detail.join("; "));
    assert.equal(result.full?.dbShardsAgree, true, result.full?.detail.join("; "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify flags a corrupted/hand-edited shard hash as hand-edit, never as lag (§8 amendment)", () => {
  const db = freshDb();
  seedRich(db);
  const dir = tmpProjectDir();
  try {
    exportProject(db, dir);
    const findingsDir = join(dir, "analysis", "findings");
    const file = join(findingsDir, readdirSync(findingsDir)[0]!);
    const shard = JSON.parse(readFileSync(file, "utf8"));
    // The realistic hand-edit fingerprint (§8): content changed, hash NOT
    // re-locked — a human editing the JSON by hand has no reason to
    // recompute a sha256 over sorted keys. This is exactly what
    // distinguishes a hand edit from lag: lag is a file whose OWN content
    // still matches its own recorded hash; a hand edit's does not.
    shard.contentHash = "0".repeat(64);
    writeFileSync(file, JSON.stringify(shard, null, 2));

    const result = verifyProject(db, dir);
    assert.equal(result.ok, false);
    const bad = result.shards.find((s) => s.path === file);
    assert.equal(bad?.status, "hand-edit");
    assert.notEqual(bad?.status, "lag", "the §8 amendment: a hand edit must never be classified as lag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify flags a broken log hash chain", () => {
  const db = freshDb();
  seedRich(db);
  const dir = tmpProjectDir();
  try {
    exportProject(db, dir);
    const logDir = join(dir, "log");
    const file = join(logDir, readdirSync(logDir)[0]!);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[1]!);
    entry.prevHash = "tampered";
    lines[1] = JSON.stringify(entry);
    writeFileSync(file, `${lines.join("\n")}\n`);

    const result = verifyProject(db, dir);
    assert.equal(result.ok, false);
    assert.equal(result.logChain.some((c) => !c.ok), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify classifies an unchanged-but-stale shard as lag when the DB has moved on", () => {
  const db = freshDb();
  seedRich(db);
  const dir = tmpProjectDir();
  try {
    exportProject(db, dir);
    // The DB advances (a new write) but we do NOT re-export — simulates the
    // crash-between-commit-and-export window (§8 "Live").
    dbSetName(db, "fn:9", "freshlyAdded", humanProv(), { ts: "2026-09-04T00:10:00.000Z" });

    const result = verifyProject(db, dir);
    // Every shard on disk is still self-consistent (nobody touched it by
    // hand) but now behind the DB's current version -> lag, not hand-edit,
    // and NOT a verify failure (lag alone must not fail verify).
    assert.ok(result.shards.length > 0);
    for (const s of result.shards) assert.equal(s.status, "lag", `${s.path} expected lag, got ${s.status}`);
    assert.equal(result.ok, true, "lag alone must not fail verify");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuild refuses to double-insert onto a non-fresh DB (revisions.rid collision)", () => {
  const db = freshDb();
  seedRich(db);
  const dir = tmpProjectDir();
  try {
    exportProject(db, dir);
    // `db` itself already has these rows; rebuilding INTO it must fail
    // loudly (primary-key collision) rather than silently duplicating or
    // corrupting state — rebuild's contract is "target is a fresh DB".
    assert.throws(() => rebuildProject(db, dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hbcproj CLI: rebuild recovers a project after cache.db is deleted, verify then passes", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
  const fixture = fileURLToPath(new URL("../../tests/fixtures/constructs/04-for-loop-basic/v96.hbc", import.meta.url));
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-hbcproj-rebuild-cli-"));
  function run(args: string[]) {
    return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  }
  try {
    const init = run(["init", fixture, "--out", outDir]);
    assert.equal(init.status, 0, init.stderr);
    const dbPath = join(outDir, "project.hbcproj");

    // Seed one annotation via a tiny inline script would need extra
    // plumbing; instead exercise export on the init-only DB (no
    // annotations yet is still a valid, if small, round trip) and prove the
    // CLI verbs behave end to end.
    const exp = run(["hbcproj", "export", dbPath]);
    assert.equal(exp.status, 0, exp.stderr);
    assert.ok(existsSync(join(outDir, "analysis")));

    const verifyClean = run(["hbcproj", "verify", dbPath, "--full"]);
    assert.equal(verifyClean.status, 0, verifyClean.stderr + verifyClean.stdout);
    assert.match(verifyClean.stdout, /OK/);

    // Simulate cache.db loss: delete it, then recover via rebuild.
    rmSync(dbPath);
    const rebuild = run(["hbcproj", "rebuild", dbPath]);
    assert.equal(rebuild.status, 0, rebuild.stderr);
    assert.ok(existsSync(dbPath), "rebuild must (re)create project.hbcproj");

    const verifyAfter = run(["hbcproj", "verify", dbPath, "--full"]);
    assert.equal(verifyAfter.status, 0, verifyAfter.stderr + verifyAfter.stdout);
    assert.match(verifyAfter.stdout, /OK/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
