// tests/project/merge.test.ts — A-CONFLICT (docs/specs/11-project-store.md
// §2.3, §7 step 7): `project merge <otherDir>` line-unions two stores over
// the SAME artifact, mints an explicit `conflict` record on a same-slot
// double-supersede (never a silent pick), and REFUSES a merge across
// different `builtFor` (reviewer ruling 4). Structural/property assertions
// only, on private artifacts — no exact-output string comparison against a
// shared decompile (project CLAUDE.md's testing rule).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, cpSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { ArtifactService } from "../../src/artifact/service.ts";
import { ProjectService } from "../../src/project/service.ts";

const FIXTURE_A = join(repoRoot(), "tests", "fixtures", "constructs", "01-if-else-chain", "v94.hbc");
const FIXTURE_B = join(repoRoot(), "tests", "fixtures", "constructs", "02-while-loop", "v94.hbc");

const HUMAN = { source: "human" as const, who: "fred" };

function buildArtifactDir(hbcPath: string): string {
  const bytes = readFileSync(hbcPath);
  const splitResult = splitProject(bytes, { moduleName: "index.hbc" });
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-project-merge-"));
  writeArtifact({ bytes, splitResult, outDir: dir, passes: {}, strictEnv: false, form: "flat" });
  return dir;
}

function openSvc(dir: string): ProjectService {
  return new ProjectService(dir, new ArtifactService(dir));
}

test("merge is a line-union of two stores over the SAME builtFor", () => {
  const x = buildArtifactDir(FIXTURE_A);
  const y = buildArtifactDir(FIXTURE_A);
  try {
    openSvc(x).setTag("fn:0", "reviewed", HUMAN);
    openSvc(y).setTag("fn:1", "source", HUMAN);

    const svcX = openSvc(x);
    const before = svcX.stat();
    assert.equal(before.tags, 1);

    const result = svcX.mergeFrom(y);
    assert.equal(result.conflictCount, 0);

    const after = openSvc(x).stat();
    assert.equal(after.tags, 2, "both sessions' tags present after union");
    assert.equal(after.conflicts, 0);

    assert.equal(openSvc(x).tagsOn("fn:0").rows.length, 1);
    assert.equal(openSvc(x).tagsOn("fn:1").rows.length, 1);
  } finally {
    rmSync(x, { recursive: true, force: true });
    rmSync(y, { recursive: true, force: true });
  }
});

test("a same-slot double-supersede mints an explicit conflict record — never a silent pick (A-CONFLICT)", () => {
  const base = buildArtifactDir(FIXTURE_A);
  openSvc(base).setTag("fn:0", "reviewed", HUMAN, { note: "base" });

  const x = mkdtempSync(join(tmpdir(), "hbc2js-project-merge-x-"));
  const y = mkdtempSync(join(tmpdir(), "hbc2js-project-merge-y-"));
  cpSync(base, x, { recursive: true });
  cpSync(base, y, { recursive: true });
  try {
    // Two sessions independently re-assert (supersede) the SAME slot.
    openSvc(x).setTag("fn:0", "reviewed", HUMAN, { note: "confirmed-by-x" });
    openSvc(y).setTag("fn:0", "reviewed", HUMAN, { note: "confirmed-by-y" });

    const svcX = openSvc(x);
    const result = svcX.mergeFrom(y);
    assert.equal(result.conflictCount, 1);

    const svcX2 = openSvc(x);
    assert.equal(svcX2.stat().conflicts, 1);

    // Both sessions' new records survive — no silent pick.
    const onSlot = svcX2.tagsOn("fn:0").rows;
    const notes = onSlot.map((r) => r.note).sort();
    assert.deepEqual(notes, ["confirmed-by-x", "confirmed-by-y"]);

    const conflicts = svcX2.conflicts({});
    assert.equal(conflicts.total, 1);
    assert.equal(conflicts.rows[0]!.file, "tags");
    assert.equal(conflicts.rows[0]!.record.target, "fn:0");
    assert.equal(conflicts.rows[0]!.record.rids.length, 2);
    assert.equal(conflicts.rows[0]!.record.prov.source, "tool");

    // Re-running the merge against the SAME (unchanged) other store must not
    // duplicate data or mint a second conflict — idempotent/deterministic.
    const secondRun = openSvc(x).mergeFrom(y);
    assert.equal(secondRun.conflictCount, 0);
    assert.equal(openSvc(x).stat().conflicts, 1);
    assert.equal(openSvc(x).tagsOn("fn:0").rows.length, 2);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(x, { recursive: true, force: true });
    rmSync(y, { recursive: true, force: true });
  }
});

test("merge across different builtFor is REFUSED (reviewer ruling 4, §2.3)", () => {
  const x = buildArtifactDir(FIXTURE_A);
  const y = buildArtifactDir(FIXTURE_B);
  try {
    openSvc(x).setTag("fn:0", "reviewed", HUMAN);
    openSvc(y).setTag("fn:0", "reviewed", HUMAN);
    assert.throws(() => openSvc(x).mergeFrom(y), /builtFor/);
    // Refused merge must leave the store untouched.
    assert.equal(openSvc(x).stat().tags, 1);
  } finally {
    rmSync(x, { recursive: true, force: true });
    rmSync(y, { recursive: true, force: true });
  }
});

test("merged output is byte-deterministic across repeated identical merges", () => {
  const base = buildArtifactDir(FIXTURE_A);
  openSvc(base).setTag("fn:0", "reviewed", HUMAN, { note: "base" });
  const x = mkdtempSync(join(tmpdir(), "hbc2js-project-merge-detx-"));
  const y = mkdtempSync(join(tmpdir(), "hbc2js-project-merge-dety-"));
  cpSync(base, x, { recursive: true });
  cpSync(base, y, { recursive: true });
  try {
    openSvc(x).setTag("fn:0", "reviewed", HUMAN, { note: "x" });
    openSvc(y).setTag("fn:0", "reviewed", HUMAN, { note: "y" });
    openSvc(x).mergeFrom(y);
    const bytesAfterFirst = readdirSync(join(x, "project"))
      .sort()
      .map((f) => readFileSync(join(x, "project", f), "utf8"));

    openSvc(x).mergeFrom(y);
    const bytesAfterSecond = readdirSync(join(x, "project"))
      .sort()
      .map((f) => readFileSync(join(x, "project", f), "utf8"));

    // tags.jsonl carries a fresh `ts` on any NEWLY minted conflict record;
    // since the second run mints none (prior test proves this), every file
    // must be byte-identical across the two runs.
    assert.deepEqual(bytesAfterSecond, bytesAfterFirst);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(x, { recursive: true, force: true });
    rmSync(y, { recursive: true, force: true });
  }
});
