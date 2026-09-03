#!/usr/bin/env node
// tools/project/measure.ts — decision-8 metrics 2 & 3 (docs/specs/
// 11-project-store.md §5) plus the metric-4 held-out checks. Prints one
// summary block; the landing report pastes it. Formatters below mirror
// `runProject`'s CLI one-liners in `src/cli.ts` byte-for-byte (same fields,
// same truncation marker) so the measured bytes are what a real caller
// actually reads, not an approximation.
//
// Usage:
//   node tools/project/measure.ts <bundle.hbc> [--n 40]
//   node tools/project/measure.ts --orphan-check <a.hbc> <b.hbc> [--n 40]
import { mkdtempSync, readFileSync, rmSync, statSync, readdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitProject } from "../../src/split/index.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { ArtifactService } from "../../src/artifact/service.ts";
import { ProjectService } from "../../src/project/service.ts";
import type { AnnotationRow } from "../../src/project/service.ts";
import type { ResolvedFinding } from "../../src/project/findings.ts";
import { TAGS, type Provenance } from "../../src/project/schema.ts";

function bytesOf(s: string): number {
  return Buffer.byteLength(s, "utf8");
}
function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? 0 : n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}
function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(p);
    else total += statSync(p).size;
  }
  return total;
}
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

// --- CLI-shape formatters (mirror src/cli.ts runProject) -------------------
function annotationLine(row: AnnotationRow): string {
  if (row.type === "tag") return `tag ${row.record.tag} ${row.record.prov.source}${row.record.note !== undefined ? ` "${row.record.note}"` : ""}`;
  if (row.type === "comment") return `comment${row.record.range !== undefined ? ` L${row.record.range.line}` : ""} "${row.record.body.slice(0, 60)}"`;
  const rf: ResolvedFinding = row.record;
  return `finding#${rf.record.rid} ${rf.record.severity} ${rf.status} "${rf.record.claim.slice(0, 40)}"`;
}
function forFnText(svc: ProjectService, fn: number): string {
  const r = svc.forFn(fn);
  return [...r.rows.map(annotationLine), `total:${r.total}`].join("\n");
}
function tagGetText(svc: ProjectService, target: string): string {
  const r = svc.tagsOn(target);
  return r.rows.map((t) => `${t.tag} ${t.prov.source}`).join("\n");
}
function commentsText(svc: ProjectService, fn: number): string {
  const r = svc.comments(fn);
  return [...r.rows.map((c) => `${c.rid}${c.range !== undefined ? ` L${c.range.line}` : ""} "${c.body.slice(0, 60)}"`), `total:${r.total}`].join("\n");
}
function findingShowText(svc: ProjectService, rid: string): string {
  const rf = svc.finding(rid);
  if (rf === null) return "";
  return [
    `finding#${rf.record.rid} ${rf.record.severity} ${rf.status} ${rf.record.target} valid:${rf.valid}`,
    `claim: ${rf.record.claim}`,
    ...rf.refs.map((e) => `evidence ${e.ref.ref} [${e.ref.role}] resolved:${e.resolved}`),
  ].join("\n");
}
function findingsText(svc: ProjectService): string {
  const r = svc.findings({});
  return [...r.rows.map((rf) => `#${rf.record.rid} ${rf.record.severity} ${rf.status} ${rf.record.target} "${rf.record.claim.slice(0, 40)}"`), `total:${r.total}`].join("\n");
}
function bookmarksText(svc: ProjectService): string {
  const r = svc.bookmarks();
  return [...r.rows.map((b) => `${b.target}${b.label !== undefined ? ` "${b.label}"` : ""}`), `total:${r.total}`].join("\n");
}
function orphansText(svc: ProjectService): string {
  const r = svc.orphans();
  return [
    ...r.rows.map((o) => {
      const ctxBits = [o.ctx.name, o.ctx.loc, o.ctx.ownerFn].filter((x) => x !== undefined).join(" ");
      return `${o.kind}#${o.rid} ${o.target}${ctxBits !== "" ? ` [${ctxBits}]` : ""}`;
    }),
    `total:${r.total}`,
  ].join("\n");
}
function statText(svc: ProjectService): string {
  const s = svc.stat();
  return `comments:${s.comments} tags:${s.tags} bookmarks:${s.bookmarks} findings:${s.findings}\ninvalidFindings:${s.invalidFindings} orphans:${s.orphans} conflicts:${s.conflicts}`;
}

const HUMAN: Provenance = { source: "human", who: "measure" };
const TOOL: Provenance = { source: "tool", who: "measure", run: "seeded-corpus" };

function buildArtifact(hbcPath: string, outDir: string): { readonly bytes: Buffer; readonly fnIds: readonly number[] } {
  const bytes = readFileSync(hbcPath);
  const splitResult = splitProject(bytes, { moduleName: hbcPath });
  writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat", overwrite: true });
  const functionsJsonl = readFileSync(join(outDir, "index", "functions.jsonl"), "utf8").trim().split("\n").slice(1);
  const fnIds: number[] = functionsJsonl.map((l) => (JSON.parse(l) as { fn: number }).fn);
  return { bytes, fnIds };
}

function seedWrites(svc: ArtifactService, proj: ProjectService, fnIds: readonly number[], n: number, seed: number): { readonly fns: readonly number[]; readonly findingRids: readonly string[] } {
  const sample = seededSample(fnIds, Math.min(n, fnIds.length), seed).filter((fn) => {
    try {
      svc.fn(fn);
      return true;
    } catch {
      return false;
    }
  });
  const findingRids: string[] = [];
  sample.forEach((fn, i) => {
    const target = `fn:${fn}`;
    proj.setTag(target, TAGS[i % TAGS.length]!, HUMAN, { note: `seeded write ${i}` });
    proj.addComment(target, `seeded comment ${i} covering ${target} — this is a representative-length note body for token-cost measurement`, HUMAN);
    const { rid } = proj.addFinding({
      target,
      claim: `seeded claim ${i}: representative-length claim text for token-cost measurement on ${target}`,
      severity: (["low", "med", "high", "critical"] as const)[i % 4]!,
      evidence: [{ ref: target, role: "context" }],
      prov: TOOL,
    });
    findingRids.push(rid);
    proj.addBookmark(target, HUMAN, { label: `bm ${i}` });
  });
  return { fns: sample, findingRids };
}

function measureOne(hbcPath: string, n: number, seed: number): void {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-project-measure-"));
  try {
    const { fnIds } = buildArtifact(hbcPath, outDir);
    const svc0 = new ArtifactService(outDir);
    const proj0 = new ProjectService(outDir, svc0);
    const { fns, findingRids } = seedWrites(svc0, proj0, fnIds, n, seed);
    if (fns.length === 0) {
      process.stdout.write(`=== decision-8 measured (project store): ${hbcPath} === (no resolvable functions sampled — skipped)\n`);
      return;
    }

    // --- metric 3: run cost, best-of-3 -------------------------------------
    const N_RUNS = 3;
    let bestArtifactMs = Infinity;
    let bestProjectMs = Infinity;
    for (let i = 0; i < N_RUNS; i++) {
      const t0 = performance.now();
      const a = new ArtifactService(outDir);
      const t1 = performance.now();
      const p = new ProjectService(outDir, a);
      const t2 = performance.now();
      // touch p so the JIT can't dead-code-eliminate construction (also
      // exercises the resolve pass §2.5/§4.1 wire on load).
      p.stat();
      bestArtifactMs = Math.min(bestArtifactMs, t1 - t0);
      bestProjectMs = Math.min(bestProjectMs, t2 - t1);
    }
    const projectDirBytes = dirBytes(join(outDir, "project"));
    const recordLineBytes: number[] = [];
    for (const f of ["tags.jsonl", "comments.jsonl", "bookmarks.jsonl", "findings.jsonl"]) {
      const lines = readFileSync(join(outDir, "project", f), "utf8").trim().split("\n").slice(1).filter((l) => l.length > 0);
      for (const l of lines) recordLineBytes.push(bytesOf(l));
    }

    // --- metric 2: read token cost over a fixed verb corpus (20 sampled) --
    const svc = new ArtifactService(outDir);
    const proj = new ProjectService(outDir, svc);
    const sampleFns = seededSample(fns, Math.min(20, fns.length), seed);
    const sampleFindingRids = seededSample(findingRids, Math.min(20, findingRids.length), seed);

    const forFnBytes = sampleFns.map((fn) => bytesOf(forFnText(proj, fn)));
    const tagGetBytes = sampleFns.map((fn) => bytesOf(tagGetText(proj, `fn:${fn}`)));
    const commentsBytes = sampleFns.map((fn) => bytesOf(commentsText(proj, fn)));
    const findingShowBytes = sampleFindingRids.map((rid) => bytesOf(findingShowText(proj, rid)));
    // Whole-store bounded verbs: answer shape doesn't vary by argument, so
    // the corpus is the single call, reported as median=max=n=1.
    const findingsBytes = [bytesOf(findingsText(proj))];
    const bookmarksBytes = [bytesOf(bookmarksText(proj))];
    const orphansBytes = [bytesOf(orphansText(proj))];
    const statBytes = [bytesOf(statText(proj))];

    process.stdout.write(
      [
        `=== decision-8 measured (project store): ${hbcPath} (n=${fns.length} annotated fns, seed=${seed}) ===`,
        `metric 2 (read token cost, bytes per answer):`,
        `  for-fn:       median=${median(forFnBytes).toFixed(0)}B max=${Math.max(...forFnBytes)}B  n=${forFnBytes.length}  (target: median <= 1536B)`,
        `  tag get:      median=${median(tagGetBytes).toFixed(0)}B max=${Math.max(...tagGetBytes)}B  n=${tagGetBytes.length}  (target: <= 10 lines/cap)`,
        `  comments:     median=${median(commentsBytes).toFixed(0)}B max=${Math.max(...commentsBytes)}B  n=${commentsBytes.length}  (target: <= 30 lines/cap)`,
        `  finding show: median=${median(findingShowBytes).toFixed(0)}B max=${Math.max(...findingShowBytes)}B  n=${findingShowBytes.length}  (target: <= 20 lines always)`,
        `  findings:     ${findingsBytes[0]}B  (target: <= 50 lines/cap)`,
        `  bookmarks:    ${bookmarksBytes[0]}B  (target: <= 50 lines/cap)`,
        `  orphans:      ${orphansBytes[0]}B  (target: <= 50 lines/cap)`,
        `  stat:         ${statBytes[0]}B  (target: <= 15 lines/cap)`,
        `metric 3 (run cost, best-of-${N_RUNS}):`,
        `  ArtifactService construction: ${bestArtifactMs.toFixed(2)}ms`,
        `  ProjectService load+resolve:  ${bestProjectMs.toFixed(2)}ms  (${((bestProjectMs / bestArtifactMs) * 100).toFixed(1)}% of artifact-index load; target <= 15%)`,
        `  project/ on disk:             ${projectDirBytes} bytes over ${recordLineBytes.length} records`,
        `  bytes/record:                 median=${median(recordLineBytes).toFixed(0)}B max=${Math.max(...recordLineBytes)}B  (target: median <= 300B)`,
      ].join("\n") + "\n",
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// --- metric 4b: version-bump orphan zero-silent-drop check -----------------
// Annotate real functions under artifact A, then load the SAME project/
// store against artifact B built from DIFFERENT bytes (a real second
// rn-template build already committed — no network, no synthetic mutation):
// every A-only target must come back `orphaned` with its write-time ctx,
// every record must still be on disk (row count unchanged), zero silent
// drops.
function orphanCheck(hbcA: string, hbcB: string, n: number, seed: number): boolean {
  const dirA = mkdtempSync(join(tmpdir(), "hbc2js-project-orphan-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "hbc2js-project-orphan-b-"));
  try {
    const { fnIds: fnIdsA } = buildArtifact(hbcA, dirA);
    buildArtifact(hbcB, dirB);
    const svcA = new ArtifactService(dirA);
    const svcB = new ArtifactService(dirB);
    const projA = new ProjectService(dirA, svcA);
    const { fns } = seedWrites(svcA, projA, fnIdsA, n, seed);
    const notInB = fns.filter((fn) => !svcB.hasFn(fn));

    const rowsBefore = countProjectRows(dirA);

    rmSync(join(dirB, "project"), { recursive: true, force: true });
    cpSync(join(dirA, "project"), join(dirB, "project"), { recursive: true });
    const rowsAfterCopy = countProjectRows(dirB);

    const projB = new ProjectService(dirB, svcB);
    const orphans = projB.orphans({ all: true });
    const orphanTargets = new Set(orphans.rows.map((o) => o.target));
    const expectedOrphanTargets = new Set(notInB.map((fn) => `fn:${fn}`));

    const zeroSilentDrop = rowsAfterCopy === rowsBefore;
    const everyVanishedIsOrphan = [...expectedOrphanTargets].every((t) => orphanTargets.has(t));
    const everyOrphanHasCtx = orphans.rows.every((o) => o.ctx.ownerFn !== undefined || o.ctx.name !== undefined || o.ctx.loc !== undefined);
    const pass = zeroSilentDrop && everyVanishedIsOrphan && everyOrphanHasCtx;

    process.stdout.write(
      [
        `=== decision-8 metric 4 (version-bump orphan check): A=${hbcA} B=${hbcB} ===`,
        `  annotated fns under A: ${fns.length}, vanished under B: ${notInB.length}`,
        `  rows on disk before copy: ${rowsBefore}, after copy to B: ${rowsAfterCopy}  (zero-silent-drop: ${zeroSilentDrop})`,
        `  orphaned under B: ${orphans.total}  (every vanished target flagged: ${everyVanishedIsOrphan}; every orphan carries ctx: ${everyOrphanHasCtx})`,
        `  ${pass ? "PASS" : "FAIL"}: zero silent drops, orphan policy fires (target: true)`,
      ].join("\n") + "\n",
    );
    return pass;
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
}

function countProjectRows(dir: string): number {
  let total = 0;
  for (const f of ["tags.jsonl", "comments.jsonl", "bookmarks.jsonl", "findings.jsonl"]) {
    const p = join(dir, "project", f);
    try {
      total += readFileSync(p, "utf8").trim().split("\n").slice(1).filter((l) => l.length > 0).length;
    } catch {
      /* file not yet created (no writes of that kind) */
    }
  }
  return total;
}

function main(): void {
  const argv = process.argv.slice(2);
  const n = Number(argv[argv.indexOf("--n") + 1] ?? 40);
  const seed = Number(argv[argv.indexOf("--seed") + 1] ?? 1);
  if (argv[0] === "--orphan-check") {
    const a = argv[1];
    const b = argv[2];
    if (a === undefined || b === undefined) {
      process.stderr.write("usage: measure.ts --orphan-check <a.hbc> <b.hbc> [--n 40]\n");
      process.exit(2);
    }
    process.exit(orphanCheck(a, b, n, seed) ? 0 : 1);
  }
  const hbcPath = argv.find((a) => !a.startsWith("-"));
  if (hbcPath === undefined) {
    process.stderr.write("usage: measure.ts <bundle.hbc> [--n 40] [--seed 1]\n       measure.ts --orphan-check <a.hbc> <b.hbc> [--n 40]\n");
    process.exit(2);
  }
  measureOne(hbcPath, n, seed);
}

main();
