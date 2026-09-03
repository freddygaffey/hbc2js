// tests/project/service.test.ts — P2.2 project-store steps 5-6
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

// A-ORPHAN (docs/specs/11-project-store.md §2.5, §7 step 6): annotate a real
// target, then load the SAME store against an artifact with a DIFFERENT
// `builtFor` where that target no longer resolves — `fn:1` is a real
// function in FIXTURE_A (if-else-chain) that FIXTURE_B (while-loop) does not
// have (confirmed by probing both artifacts' `hasFn`). Opening must NOT
// throw (step 5's refusal is relaxed, module header); the record must
// become `orphaned`: excluded from active reads, listed by `orphans()` with
// its write-time `ctx`, counted in `stat()`, and NEVER dropped from disk.
test("cross-builtFor load flags a vanished target as orphaned — never drops it (A-ORPHAN)", () => {
  const b = buildArtifact(FIXTURE_B);
  try {
    assert.equal(a.svc.hasFn(1), true);
    assert.equal(b.svc.hasFn(1), false);

    const setResult = new ProjectService(a.dir, a.svc).setTag("fn:1", "reviewed", HUMAN, { note: "cross-build orphan probe" });

    rmSync(join(b.dir, "project"), { recursive: true, force: true });
    cpSync(join(a.dir, "project"), join(b.dir, "project"), { recursive: true });

    // Opening against the mismatched artifact does not throw.
    const svcB = new ProjectService(b.dir, b.svc);

    // Excluded from active reads.
    assert.deepEqual(svcB.tagsOn("fn:1").rows, []);
    assert.deepEqual(svcB.forFn(1).rows, []);

    // Live-computed, with last-known ctx, counted in stat() — zero drops.
    const orphans = svcB.orphans();
    assert.equal(orphans.total, 1);
    assert.equal(orphans.rows.length, 1);
    assert.equal(orphans.rows[0]?.kind, "tag");
    assert.equal(orphans.rows[0]?.rid, setResult.rid);
    assert.equal(orphans.rows[0]?.target, "fn:1");
    assert.equal(orphans.rows[0]?.ctx.ownerFn, "fn:1");
    assert.equal(svcB.stat().orphans, 1);

    // Never a mutation of the stored line: reopened against the ORIGINAL
    // (matching) artifact, the exact same record is active and NOT
    // orphaned — the tag itself was never touched, only excluded live.
    const svcAAgain = new ProjectService(a.dir, a.svc);
    assert.equal(svcAAgain.stat().orphans, 0);
    assert.equal(svcAAgain.tagsOn("fn:1").rows.length, 1);
    assert.equal(svcAAgain.tagsOn("fn:1").rows[0]?.rid, setResult.rid);
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

test("conflicts() stays a step-7 stub; orphans() is empty when nothing on this store is orphaned", () => {
  const svc = new ProjectService(a.dir, a.svc);
  // Every annotation this file has written to `a.dir` targets a real fn
  // (0 or 1, or a distinct `reg:0:*`/`reg:1:*`) — see the A-BOUNDS test
  // below, which switched off bare high `fn:N` targets for exactly this
  // reason (§2.5's real orphan detection, step 6). The one write that used
  // an unresolving target (`fn:99999`, the §4.1 rejection test above) was
  // never persisted. So `orphans()` is genuinely empty here, not a stub.
  assert.deepEqual(svc.orphans(), { rows: [], total: 0, truncated: false });
  assert.deepEqual(svc.conflicts(), { rows: [], total: 0, truncated: false });
});

test("every §3.1 verb caps its default answer and announces truncation (A-BOUNDS)", () => {
  const svc = new ProjectService(a.dir, a.svc);
  // distinct targets — bookmarks slot on `target` alone (bookmarks.ts module
  // header), so re-bookmarking the SAME target would just supersede, not
  // add. Uses `reg:0:N` (register N of the real fn 0), not a bare high
  // `fn:N`: since step 6 (§2.5) live-excludes orphaned targets from every
  // read incl. `bookmarks()`, a fabricated `fn:1000+` (this fixture has only
  // 2 real functions) would be orphaned and filtered out, breaking this
  // truncation count — `reg:0:N` stays distinct per `i` while resolving
  // (fn 0 is real), same as a real per-register bookmark would.
  for (let i = 0; i < 60; i++) svc.addBookmark(`reg:0:${1000 + i}`, HUMAN, { label: `mark-${i}` });
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
