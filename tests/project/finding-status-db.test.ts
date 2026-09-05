// tests/project/finding-status-db.test.ts — the DB-backed half of A-STATUS
// (docs/BUGS.md 2026-09-05 "setFindingStatus, DB-backed branch" row): a
// status transition written against a project.hbcproj-backed project must be
// visible on every later read, exactly as it is for a JSONL-backed one.
// `ProjectService.setFindingStatus`'s DB branch folds a transition into a
// fresh `kind='finding'` revision (no `d_status` table exists); the read path
// (`src/projdb/project-read.ts`'s `splitFindingRevisions`) unfolds it again
// into the `finding`/`status` pair `FindingStore` is built around. Both
// backends are exercised with the SAME calls here so the parity is asserted,
// not assumed. Structural/property assertions on a private fixture only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { ArtifactService } from "../../src/artifact/service.ts";
import { ProjectService } from "../../src/project/service.ts";
import type { Provenance } from "../../src/project/schema.ts";

const FIXTURE = join(repoRoot(), "tests", "fixtures", "constructs", "01-if-else-chain", "v94.hbc");
const HUMAN: Provenance = { source: "human", who: "analyst@duck.com" };
const CLAIM = "user-controlled response flows into eval";
// `fuzz:` is a dynamic-role ref (`open->confirmed` needs one, spec 11 §4.1 as
// revised by spec 17 §14) and `ArtifactEvidenceResolver` resolves it against
// a repo-relative path, so `package.json` always resolves.
const DYNAMIC = { ref: "fuzz:package.json", role: "dynamic" } as const;

/** A fresh artifact dir; DB-backed adds a `project.hbcproj` beside the JSONL
 *  artifact (`hbc2js init`'s §4.3 coexistence layout, as tests/projdb/
 *  stale.test.ts builds it), which is what makes `ProjectService` take the
 *  DB branch of every write verb. */
function buildProject(dbBacked: boolean): { readonly dir: string; readonly svc: ProjectService } {
  const bytes = readFileSync(FIXTURE);
  const splitResult = splitProject(bytes, { moduleName: "index.hbc" });
  const dir = mkdtempSync(join(tmpdir(), `hbc2js-finding-status-${dbBacked ? "db" : "jsonl"}-`));
  writeArtifact({ bytes, splitResult, outDir: dir, passes: {}, strictEnv: false, form: "flat" });
  if (dbBacked) {
    const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
    const db = openProjectDb(join(dir, "project.hbcproj"));
    initProjectDb(db, rows, { actorWho: "test" });
    db.close();
  }
  const artifact = new ArtifactService(dir);
  assert.equal(artifact.dbBacked, dbBacked);
  return { dir, svc: new ProjectService(dir, artifact) };
}

function recordAndConfirm(svc: ProjectService): string {
  const { rid } = svc.addFinding({ target: "fn:0", claim: CLAIM, severity: "high", evidence: [{ ref: "fn:0", role: "source" }], prov: HUMAN });
  svc.setFindingStatus(rid, "confirmed", [DYNAMIC], HUMAN);
  return rid;
}

for (const dbBacked of [true, false]) {
  const backend = dbBacked ? "DB-backed" : "JSONL-backed";

  test(`${backend}: a confirmed finding reads back as confirmed, under its own rid and in the findings list`, () => {
    const { dir, svc } = buildProject(dbBacked);
    try {
      const rid = recordAndConfirm(svc);

      // The BUGS row's PROVE clause: `finding show <rid>` and the findings
      // list both report the transition, not the creation status.
      const shown = svc.finding(rid);
      assert.notEqual(shown, null);
      assert.equal(shown?.status, "confirmed");

      const rows = svc.findings({}, { all: true }).rows.filter((rf) => rf.record.claim === CLAIM);
      assert.equal(rows.length, 1, "exactly one live finding for the claim (the transition never forks it)");
      assert.equal(rows[0]?.status, "confirmed");
      // The finding's rid is stable across a transition: the rid handed back
      // by `record_finding` is still the one the live row carries.
      assert.equal(rows[0]?.record.rid, rid);
      // The claim's own evidence stays on the finding and stays resolvable.
      assert.deepEqual(rows[0]?.record.evidence.map((e) => e.ref), ["fn:0"]);
      assert.equal(rows[0]?.valid, true);

      // A `status` filter is the same read through a different door.
      assert.equal(svc.findings({ status: "confirmed" }, { all: true }).total, 1);
      assert.equal(svc.findings({ status: "open" }, { all: true }).total, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${backend}: the transition survives reopening the project from disk`, () => {
    const { dir, svc } = buildProject(dbBacked);
    try {
      const rid = recordAndConfirm(svc);
      const artifact = new ArtifactService(dir);
      const reopened = new ProjectService(dir, artifact);
      assert.equal(reopened.finding(rid)?.status, "confirmed");
      assert.equal(reopened.stat().findings, 1, "a transition is not a second finding");
      assert.equal(reopened.stat().invalidFindings, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${backend}: the live status the transition rules read is the transition's own`, () => {
    const { dir, svc } = buildProject(dbBacked);
    try {
      const rid = recordAndConfirm(svc);
      // Both backends refuse a second confirm (`already confirmed`) — the
      // status `checkStatusTransition` compares against is the live one.
      assert.throws(() => svc.setFindingStatus(rid, "confirmed", [DYNAMIC], HUMAN), /already confirmed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
