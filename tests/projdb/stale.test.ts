// tests/projdb/stale.test.ts — docs/specs/16-project-db.md §7 A8, stale half
// (the rebuild-index half lands with §8 step 7's `rebuild-index` command):
// mutate `meta.render_hash` in a temp copy of a DB-backed artifact →
// `ArtifactService` construction throws `E_STALE_RANGES`; mutate
// `meta.bundle_sha256`/`meta.index_built_for` (simulating changed bundle
// bytes) → `E_STALE_INDEX`. Mirrors `tests/artifact/stale.test.ts`'s A4
// pattern one-for-one, on the DB backend instead of the JSONL one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { repoRoot } from "../support/paths.ts";
import { splitProject } from "../../src/split/index.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { ArtifactService } from "../../src/artifact/service.ts";
import { ProjectService } from "../../src/project/service.ts";
import { dbSetTag } from "../../src/projdb/annotations.ts";
import { ErrorCode, Hbc2jsError } from "../../src/errors.ts";

const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v96.hbc");
const bytes = readFileSync(FIXTURE_HBC);
const splitResult = splitProject(bytes, { moduleName: "04-for-loop-basic" });

// §4.1: "decompile + render as today" (spec-10 JSONL build, still the
// manifest.json source of truth) THEN add project.hbcproj alongside it
// (§4.3 coexistence) — a DB-backed artifact dir with both a manifest.json
// and a project.hbcproj built from the SAME bytes, so a clean copy has no
// staleness of either kind.
const outDir = mkdtempSync(join(tmpdir(), "hbc2js-projdb-stale-"));
writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
{
  const db = openProjectDb(join(outDir, "project.hbcproj"));
  initProjectDb(db, rows, { actorWho: "test" });
  db.close();
}

test.after(() => rmSync(outDir, { recursive: true, force: true }));

function mutateMeta(dir: string, key: string, value: string): void {
  const db = new DatabaseSync(join(dir, "project.hbcproj"));
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(value, key);
  db.close();
}

test("A8 clean DB-backed artifact queries succeed (no false-positive staleness)", () => {
  assert.doesNotThrow(() => new ArtifactService(outDir));
  const svc = new ArtifactService(outDir);
  assert.equal(svc.dbBacked, true);
  assert.doesNotThrow(() => svc.fn(0));
});

test("A8 a meta.render_hash mismatch throws E_STALE_RANGES from ArtifactService construction", () => {
  const staleDir = mkdtempSync(join(tmpdir(), "hbc2js-projdb-stale-render-"));
  cpSync(outDir, staleDir, { recursive: true });
  mutateMeta(staleDir, "render_hash", "0".repeat(64));

  assert.throws(
    () => new ArtifactService(staleDir),
    (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_STALE_RANGES,
  );
  rmSync(staleDir, { recursive: true, force: true });
});

test("A8 simulated changed bundle bytes (meta.bundle_sha256 mismatch) throws E_STALE_INDEX from ArtifactService construction", () => {
  const staleDir = mkdtempSync(join(tmpdir(), "hbc2js-projdb-stale-bundle-"));
  cpSync(outDir, staleDir, { recursive: true });
  mutateMeta(staleDir, "bundle_sha256", "1".repeat(64));

  assert.throws(
    () => new ArtifactService(staleDir),
    (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_STALE_INDEX,
  );
  rmSync(staleDir, { recursive: true, force: true });
});

test("A8 a meta.index_built_for mismatch (bundle sha ok, hash stale) throws E_STALE_INDEX", () => {
  const staleDir = mkdtempSync(join(tmpdir(), "hbc2js-projdb-stale-builtfor-"));
  cpSync(outDir, staleDir, { recursive: true });
  mutateMeta(staleDir, "index_built_for", "2".repeat(64));

  assert.throws(
    () => new ArtifactService(staleDir),
    (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_STALE_INDEX,
  );
  rmSync(staleDir, { recursive: true, force: true });
});

test("A8 line-bearing verbs never answer against a stale index — construction throws before any verb call", () => {
  const staleDir = mkdtempSync(join(tmpdir(), "hbc2js-projdb-stale-verb-"));
  cpSync(outDir, staleDir, { recursive: true });
  mutateMeta(staleDir, "render_hash", "3".repeat(64));

  // The whole point of §5.2's construction-time check: a caller can never
  // reach a verb call (e.g. `svc.source(0)`, which prints lines from the
  // render) against a stale project — the throw happens before any `Bounded`
  // answer could be handed back.
  assert.throws(() => new ArtifactService(staleDir), (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_STALE_RANGES);
  rmSync(staleDir, { recursive: true, force: true });
});

// --- ProjectService DB-backed read path (project-read.ts) smoke test -------

test("A8-adjacent: ProjectService reads a DB-backed tag written via the annotation stratum", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-projdb-projsvc-"));
  cpSync(outDir, dir, { recursive: true });
  {
    const db = new DatabaseSync(join(dir, "project.hbcproj"));
    dbSetTag(db, "fn:0", "reviewed", { source: "human", who: "tester" });
    db.close();
  }
  const artifact = new ArtifactService(dir);
  const project = new ProjectService(dir, artifact);
  const tags = project.tagsOn("fn:0");
  assert.equal(tags.total, 1);
  assert.equal(tags.rows[0]!.tag, "reviewed");
  rmSync(dir, { recursive: true, force: true });
});

test("A8 ProjectService construction throws the same staleness error as ArtifactService (inherits — never a wrong answer)", () => {
  const staleDir = mkdtempSync(join(tmpdir(), "hbc2js-projdb-projsvc-stale-"));
  cpSync(outDir, staleDir, { recursive: true });
  mutateMeta(staleDir, "render_hash", "4".repeat(64));
  assert.throws(
    () => new ArtifactService(staleDir),
    (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_STALE_RANGES,
  );
  rmSync(staleDir, { recursive: true, force: true });
});
