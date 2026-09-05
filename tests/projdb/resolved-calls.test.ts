// tests/projdb/resolved-calls.test.ts — docs/BUGS.md 2026-09-05
// `ix_calls_resolved` row: the project DB had no table for the `require(N)`
// points-to pass's edges, so a DB-backed `ArtifactService` served zero
// points-to edges while the JSONL path (`index/calls-resolved.jsonl`) served
// them for the SAME artifact. Fixed by `schema.sql` MIGRATION 5
// (`ix_calls_resolved`), `ix-write.ts`'s `writeResolvedCalls`, and
// `artifact-read.ts`'s `loadIndexRowsFromDb` reading them back.
//
// Rung rule (CLAUDE.md testing rules): a property assertion (identical
// `who-calls` rows on a DB-backed and a JSONL-backed copy of the same
// artifact), never a literal-string compare against a shared fixture's
// decompiled output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { ArtifactService } from "../../src/artifact/service.ts";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";
import { repoRoot } from "../support/paths.ts";

// This construct fixture (spec 10 §2.2a's own acceptance test,
// tests/gate/artifact/points-to.test.ts) is the one place a resolved edge is
// guaranteed to exist, independent of whether rn-template's own bundle
// happens to carry a provable `require(N)` receiver.
const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "62-require-slot-dispatch", "v96.hbc");
const fixtureBytes = readFileSync(FIXTURE_HBC);
const fixtureSplit = splitProject(fixtureBytes, {});
const fixtureRows = buildIndexRows({ bytes: fixtureBytes, splitResult: fixtureSplit, passes: {}, strictEnv: false, form: "flat" });

assert.ok(fixtureRows.resolvedCallRows.length >= 1, "the 62-require-slot-dispatch fixture must carry at least one points-to edge");
const sample = fixtureRows.resolvedCallRows[0]!;

const jsonlDir = mkdtempSync(join(tmpdir(), "hbc2js-resolved-calls-jsonl-"));
writeArtifact({ bytes: fixtureBytes, splitResult: fixtureSplit, outDir: jsonlDir, passes: {}, strictEnv: false, form: "flat" });

const dbDir = mkdtempSync(join(tmpdir(), "hbc2js-resolved-calls-db-"));
const db = openProjectDb(join(dbDir, "project.hbcproj"));
initProjectDb(db, fixtureRows, { actorWho: "test" });
db.close();

test.after(() => {
  rmSync(jsonlDir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

test("ix_calls_resolved round-trips: DB read-back matches the IndexRows it was written from", () => {
  const svc = new ArtifactService(dbDir);
  const callers = svc.whoCalls(sample.callee, { all: true });
  const marked = callers.rows.filter((e) => e.confidence === "points-to");
  assert.ok(marked.length >= 1, "the DB-backed ArtifactService must serve at least one points-to edge");
});

test("who-calls returns identical points-to rows on a DB-backed and a JSONL-backed copy of the same artifact", () => {
  const svcJsonl = new ArtifactService(jsonlDir);
  const svcDb = new ArtifactService(dbDir);
  assert.equal(svcDb.dbBacked, true);
  assert.equal(svcJsonl.dbBacked, false);

  const canon = (rows: readonly unknown[]): string[] => rows.map((r) => JSON.stringify(r)).sort();

  const jsonlWhoCalls = svcJsonl.whoCalls(sample.callee, { all: true });
  const dbWhoCalls = svcDb.whoCalls(sample.callee, { all: true });
  assert.deepEqual(canon(dbWhoCalls.rows), canon(jsonlWhoCalls.rows));
  assert.equal(dbWhoCalls.total, jsonlWhoCalls.total);
  assert.ok(dbWhoCalls.rows.some((e) => e.confidence === "points-to"), "who-calls must actually carry a points-to edge for this assertion to be meaningful");

  const jsonlCallsFrom = svcJsonl.callsFrom(sample.caller, { all: true });
  const dbCallsFrom = svcDb.callsFrom(sample.caller, { all: true });
  assert.deepEqual(canon(dbCallsFrom.rows), canon(jsonlCallsFrom.rows));
  assert.equal(dbCallsFrom.total, jsonlCallsFrom.total);
});

test("a DB written before MIGRATION 5 (no ix_calls_resolved table) still opens and serves zero points-to edges, never an error", () => {
  // Simulates a pre-MIGRATION-5 DB by dropping the table AFTER a normal
  // `initProjectDb` succeeded (dropping it first would make `writeIxRows`'s
  // own `db.prepare(INSERT INTO ix_calls_resolved ...)` fail even with zero
  // rows) — exercises `loadIndexRowsFromDb`'s missing-table fallback
  // (artifact-read.ts) without needing an actual pre-migration fixture.
  const oldDir = mkdtempSync(join(tmpdir(), "hbc2js-resolved-calls-old-"));
  test.after(() => rmSync(oldDir, { recursive: true, force: true }));
  const oldDb = openProjectDb(join(oldDir, "project.hbcproj"));
  initProjectDb(oldDb, fixtureRows, { actorWho: "test" });
  oldDb.exec("DROP TABLE ix_calls_resolved;");
  oldDb.close();

  const svc = new ArtifactService(oldDir);
  const callers = svc.whoCalls(sample.callee, { all: true });
  assert.equal(callers.rows.filter((e) => e.confidence === "points-to").length, 0);
});
