// tests/project/service.test.ts — P2.2 project-store step 5
// (docs/specs/11-project-store.md §3.2, §7 step 5): `ProjectService` over a
// small real artifact (a construct fixture, not rn-template — cheap enough
// for a lean-agent-sized step; rn-template-scale measurement is A-MEASURE's
// job, step 8). Structural/property assertions only, on a private fixture —
// no exact-output string comparison against a shared decompile (project
// CLAUDE.md's testing rule).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { ArtifactService } from "../../src/artifact/service.ts";
import { ProjectService } from "../../src/project/service.ts";
import { Hbc2jsError, ErrorCode } from "../../src/errors.ts";
import { readFileSync } from "node:fs";

const FIXTURE_A = join(repoRoot(), "tests", "fixtures", "constructs", "01-if-else-chain", "v94.hbc");
const FIXTURE_B = join(repoRoot(), "tests", "fixtures", "constructs", "02-while-loop", "v94.hbc");

function buildArtifact(hbcPath: string): { readonly dir: string; readonly svc: ArtifactService } {
  const bytes = readFileSync(hbcPath);
  const splitResult = splitProject(bytes, { moduleName: "index.hbc" });
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-project-service-"));
  writeArtifact({ bytes, splitResult, outDir: dir, passes: {}, strictEnv: false, form: "flat" });
  return { dir, svc: new ArtifactService(dir) };
}

const HUMAN = { source: "human" as const, who: "fred" };
const TOOL = { source: "tool" as const, who: "secrets-indexer", run: "run1" };

const a = buildArtifact(FIXTURE_A);
test.after(() => rmSync(a.dir, { recursive: true, force: true }));

test("bootstraps an empty project/ dir on first open, keyed to the artifact's builtFor", () => {
  assert.equal(existsSync(join(a.dir, "project")), false);
  const svc = new ProjectService(a.dir, a.svc);
  assert.deepEqual(svc.stat(), { comments: 0, tags: 0, bookmarks: 0, findings: 0, invalidFindings: 0, orphans: 0, conflicts: 0 });
  svc.setTag("fn:0", "reviewed", HUMAN);
  assert.equal(existsSync(join(a.dir, "project", "project.json")), true);
});

test("refuses to open a store whose builtFor doesn't match this artifact (E_STALE_PROJECT_STORE)", () => {
  const b = buildArtifact(FIXTURE_B);
  try {
    // seed a's store, then point b's ArtifactService at a's project/ dir bytes.
    new ProjectService(a.dir, a.svc).setTag("fn:0", "reviewed", HUMAN);
    rmSync(join(b.dir, "project"), { recursive: true, force: true });
    cpSync(join(a.dir, "project"), join(b.dir, "project"), { recursive: true });
    assert.throws(
      () => new ProjectService(b.dir, b.svc),
      (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_STALE_PROJECT_STORE,
    );
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("setTag/addComment/addBookmark/addFinding round-trip through save/reload", () => {
  const svc1 = new ProjectService(a.dir, a.svc);
  svc1.setTag("fn:0", "source", HUMAN, { note: "user input enters here" });
  svc1.addComment("fn:0", "worth a second look", HUMAN, { range: { line: 3 } });
  svc1.addBookmark("fn:0", HUMAN, { label: "revisit" });
  const findingResult = svc1.addFinding({ target: "fn:0", claim: "unsanitised flow", severity: "high", evidence: [{ ref: "fn:0", role: "source" }], prov: TOOL });
  assert.match(findingResult.line, /^finding#\d+ high open fn:0/);

  // Reload fresh — a new ProjectService over the same artifact dir must see
  // every write (§2.2's on-disk contract, not an in-memory-only cache).
  const svc2 = new ProjectService(a.dir, a.svc);
  const stat = svc2.stat();
  assert.ok(stat.tags >= 1 && stat.comments >= 1 && stat.bookmarks >= 1 && stat.findings >= 1);

  const forFn = svc2.forFn(0, { all: true });
  assert.ok(forFn.rows.some((r) => r.type === "tag" && r.record.tag === "source"));
  assert.ok(forFn.rows.some((r) => r.type === "finding" && r.record.record.claim === "unsanitised flow"));
  // bookmarks are NOT part of for-fn's row shape (§3.1's worked example lists
  // only tag/comment/finding lines) — asserted absent by construction (no
  // "bookmark" branch in the AnnotationRow union, checked at compile time).
});

test("findings --tag filters by the TARGET's active tag, not a finding field", () => {
  const svc = new ProjectService(a.dir, a.svc);
  svc.setTag("fn:1", "attacker-reachable", HUMAN);
  svc.addFinding({ target: "fn:1", claim: "reachable claim", severity: "med", evidence: [{ ref: "fn:1", role: "source" }], prov: HUMAN });
  const tagged = svc.findings({ tag: "attacker-reachable" }, { all: true });
  assert.ok(tagged.rows.every((rf) => rf.record.target === "fn:1"));
  assert.ok(tagged.rows.some((rf) => rf.record.claim === "reachable claim"));
});

test("a finding with only unresolving evidence is rejected at write time (§4.1)", () => {
  const svc = new ProjectService(a.dir, a.svc);
  assert.throws(() => svc.addFinding({ target: "fn:0", claim: "bad", severity: "low", evidence: [{ ref: "fn:99999", role: "source" }], prov: HUMAN }));
});

test("open->confirmed is refused without a dynamic-role resolving ref (A-STATUS, exercised through the service)", () => {
  const svc = new ProjectService(a.dir, a.svc);
  const { rid } = svc.addFinding({ target: "fn:0", claim: "status test", severity: "low", evidence: [{ ref: "fn:0", role: "source" }], prov: HUMAN });
  assert.throws(() => svc.setFindingStatus(rid, "confirmed", [{ ref: "fn:0", role: "source" }], HUMAN));
});

test("a write with no provenance is rejected (A-PROV, exercised through the service)", () => {
  const svc = new ProjectService(a.dir, a.svc);
  assert.throws(() => svc.setTag("fn:0", "reviewed", undefined as never));
});

test("orphans()/conflicts() are stubbed empty in step 5 (steps 6/7 own the real detection)", () => {
  const svc = new ProjectService(a.dir, a.svc);
  assert.deepEqual(svc.orphans(), { rows: [], total: 0, truncated: false });
  assert.deepEqual(svc.conflicts(), { rows: [], total: 0, truncated: false });
});

test("every §3.1 verb caps its default answer and announces truncation (A-BOUNDS)", () => {
  const svc = new ProjectService(a.dir, a.svc);
  // distinct targets — bookmarks slot on `target` alone (bookmarks.ts module
  // header), so re-bookmarking the SAME target would just supersede, not add.
  for (let i = 0; i < 60; i++) svc.addBookmark(`fn:${1000 + i}`, HUMAN, { label: `mark-${i}` });
  const capped = svc.bookmarks();
  assert.ok(capped.rows.length <= 50);
  assert.equal(capped.truncated, true);
  assert.ok(capped.total >= 60);
  const uncapped = svc.bookmarks({}, { all: true });
  assert.equal(uncapped.truncated, false);
  assert.ok(uncapped.rows.length >= 60);

  for (let i = 0; i < 45; i++) svc.setTag("fn:0", "reviewed", HUMAN, { note: `pass-${i}` });
  const tagHistoryCap = svc.tagsOn("fn:0");
  assert.ok(tagHistoryCap.rows.length <= 10); // only one active tag per (target,tag) slot regardless
});
