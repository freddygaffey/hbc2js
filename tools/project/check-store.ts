#!/usr/bin/env node
// tools/project/check-store.ts — the integrity checker (docs/specs/
// 11-project-store.md §5, decision-8 metric 1; §7 step 8).
//
// Replays a deterministic (--seed) write-log of tags/comments/findings
// against a real artifact THROUGH `ProjectService` (so every write-time gate
// — §4.1's finding-evidence gate, §4.2's provenance gate — is exercised
// exactly as a real caller would hit it), then verifies two invariants
// independently against the raw on-disk JSONL + the warm `ArtifactService`
// index, not by re-trusting `ProjectService`'s own live filtering:
//   1. every ACTIVE record's `target` resolves (own `targetResolves` call
//      per raw row read from `project/*.jsonl`, not "it came back from a
//      query so it must be fine").
//   2. every finding `ProjectService.findings()` returns as live/valid truly
//      has >=1 RESOLVING evidence ref (independently re-checked ref by ref
//      with a freshly-constructed `ArtifactEvidenceResolver`) — and the
//      write-time REJECTION gate itself is proven live: one deliberately-bad
//      finding (evidence pointing at a nonexistent fn) is asserted to THROW
//      rather than silently landing invalid on disk.
//
// Usage: node tools/project/check-store.ts <bundle.hbc> [--seed 1] [--n 40]
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitProject } from "../../src/split/index.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { ArtifactService } from "../../src/artifact/service.ts";
import { ProjectService } from "../../src/project/service.ts";
import { loadRecordFile } from "../../src/project/io.ts";
import { targetResolves, type TargetIndexCheck } from "../../src/project/orphans.ts";
import { ArtifactEvidenceResolver } from "../../src/project/evidence-resolver.ts";
import { TAGS } from "../../src/project/schema.ts";
import type { CommentRecord, TagRecord, BookmarkRecord, FindingRecord, StatusRecord } from "../../src/project/schema.ts";

// Own tiny LCG (same shape as tools/artifact/check-index.ts's — deliberately
// not shared, so this checker never depends on the thing it is checking).
function seededSample<T>(items: readonly T[], n: number, seed: number): T[] {
  if (n >= items.length) return [...items];
  let state = seed >>> 0 || 1;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  const pool = [...items];
  const out: T[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(rand() * pool.length);
    out.push(pool[idx]!);
    pool.splice(idx, 1);
  }
  return out;
}

const HUMAN = { source: "human" as const, who: "check-store" };
const TOOL = { source: "tool" as const, who: "check-store", run: "seeded-write-log" };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const hbcPath = argv.find((a) => !a.startsWith("-"));
  if (hbcPath === undefined) {
    process.stderr.write("usage: check-store.ts <bundle.hbc> [--seed 1] [--n 40]\n");
    process.exit(2);
  }
  const seed = Number(argv[argv.indexOf("--seed") + 1] ?? 1);
  const n = Number(argv[argv.indexOf("--n") + 1] ?? 40);

  const bytes = readFileSync(hbcPath);
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-check-store-"));
  try {
    const splitResult = splitProject(bytes, { moduleName: hbcPath });
    writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat", overwrite: true });
    const svc = new ArtifactService(outDir);
    const proj = new ProjectService(outDir, svc);

    const functionsJsonl = readFileSync(join(outDir, "index", "functions.jsonl"), "utf8").trim().split("\n").slice(1);
    const allFns: number[] = functionsJsonl.map((l) => (JSON.parse(l) as { fn: number }).fn);
    const sample = seededSample(allFns, Math.min(n, allFns.length), seed).filter((fn) => {
      try {
        svc.fn(fn);
        return true;
      } catch {
        return false;
      }
    });
    if (sample.length === 0) {
      process.stderr.write("check-store: no resolvable functions sampled from this bundle — nothing to replay\n");
      process.exit(2);
    }

    // --- replay the write-log through ProjectService (real write-time gates) ---
    let writeCount = 0;
    sample.forEach((fn, i) => {
      const target = `fn:${fn}`;
      proj.setTag(target, TAGS[i % TAGS.length]!, HUMAN, { note: `seeded write ${i}` });
      proj.addComment(target, `seeded comment ${i} on ${target}`, HUMAN);
      proj.addFinding({
        target,
        claim: `seeded claim ${i}: check reachability of ${target}`,
        severity: "low",
        evidence: [{ ref: target, role: "context" }],
        prov: TOOL,
      });
      writeCount += 3;
    });

    // Write-time rejection gate, proven live: a finding whose ONLY evidence
    // ref points at a target that cannot exist must be REJECTED, not landed
    // invalid on disk (§4.1).
    let rejected = false;
    try {
      proj.addFinding({
        target: `fn:${sample[0]}`,
        claim: "deliberately unresolving evidence — must be rejected at write time",
        severity: "low",
        evidence: [{ ref: "fn:999999999", role: "context" }],
        prov: TOOL,
      });
    } catch {
      rejected = true;
    }

    // --- reopen fresh (own load path, not the in-memory instance above) and
    // verify independently against the raw JSONL + a freshly-built resolver ---
    const reopened = new ProjectService(outDir, svc);
    const idx: TargetIndexCheck = { hasFn: (fn) => svc.hasFn(fn), hasString: (sid) => svc.hasString(sid), hasModule: (id) => svc.hasModule(id) };
    const resolver = new ArtifactEvidenceResolver(svc);

    const projectDir = join(outDir, "project");
    const tags = loadRecordFile<TagRecord>(join(projectDir, "tags.jsonl"), "tags").rows.filter((r) => r.kind === "tag" && r.active);
    const comments = loadRecordFile<CommentRecord>(join(projectDir, "comments.jsonl"), "comments").rows.filter((r) => r.active);
    const bookmarks = loadRecordFile<BookmarkRecord>(join(projectDir, "bookmarks.jsonl"), "bookmarks").rows.filter((r) => r.active);
    const findingsRaw = loadRecordFile<FindingRecord | StatusRecord>(join(projectDir, "findings.jsonl"), "findings").rows.filter((r) => r.active && r.kind === "finding") as FindingRecord[];

    let targetsChecked = 0;
    let targetsResolved = 0;
    for (const r of [...tags, ...comments, ...bookmarks, ...findingsRaw]) {
      targetsChecked++;
      if (targetResolves(r.target, idx)) targetsResolved++;
    }

    // Live findings() (excludes orphaned + invalid, §4.1/§2.5) — for every
    // row it returns, independently re-verify >=1 resolving ref.
    const liveFindings = reopened.findings({}, { all: true }).rows;
    let findingsChecked = 0;
    let findingsWithResolvingRef = 0;
    for (const rf of liveFindings) {
      findingsChecked++;
      const resolvedAny = rf.record.evidence.some((e) => resolver.resolves(e.ref));
      if (resolvedAny) findingsWithResolvingRef++;
      if (!resolvedAny) process.stderr.write(`check-store: finding ${rf.record.rid} returned live but no evidence ref independently resolves\n`);
    }
    // 0 findings raw-on-disk with unresolving-only evidence that were NOT
    // caught by the write-time gate (there should be none — this counts the
    // seeded findings themselves, all of which used a resolving `context` ref).
    let invalidOnDisk = 0;
    for (const f of findingsRaw) {
      if (!f.evidence.some((e) => resolver.resolves(e.ref))) invalidOnDisk++;
    }

    const targetIntegrity = targetsChecked === 0 ? 100 : Math.round((targetsResolved / targetsChecked) * 1000) / 10;
    const findingIntegrity = findingsChecked === 0 ? 100 : Math.round((findingsWithResolvingRef / findingsChecked) * 1000) / 10;
    const orphans = reopened.orphans({ all: true });

    const pass = targetsResolved === targetsChecked && findingsWithResolvingRef === findingsChecked && rejected && invalidOnDisk === 0;

    process.stdout.write(
      [
        `=== check-store: ${hbcPath} (seed=${seed}, n=${sample.length} fns, ${writeCount} writes) ===`,
        `metric 1 (annotation integrity):`,
        `  target resolution:  ${targetsResolved}/${targetsChecked} (${targetIntegrity}%) tags+comments+bookmarks+findings (target: 100%)`,
        `  finding evidence:   ${findingsWithResolvingRef}/${findingsChecked} (${findingIntegrity}%) live findings independently re-resolve (target: 100%)`,
        `  write-time gate:    unresolving-evidence finding rejected at write = ${rejected} (target: true)`,
        `  invalid-on-disk:    ${invalidOnDisk} finding(s) with valid:true reported but zero resolving refs (target: 0)`,
        `  orphans:            ${orphans.total} (reported, not targeted — 0 expected on a same-session replay)`,
        pass ? "check-store PASS" : "check-store FAIL",
      ].join("\n") + "\n",
    );
    process.exit(pass ? 0 : 1);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

void main();
