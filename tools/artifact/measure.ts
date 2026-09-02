#!/usr/bin/env node
// tools/artifact/measure.ts — decision-8 metrics 2 & 3 (docs/specs/
// 10-artifact-format.md §5): query token cost over a fixed query corpus, and
// index build time / size vs decompile+render time / rendered-source size.
// Prints one summary block; the landing report pastes it.
//
// Usage: node tools/artifact/measure.ts <bundle.hbc> [--out <artifactDir>]
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitProject } from "../../src/split/index.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { ArtifactService } from "../../src/artifact/service.ts";

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

function fnLine(svc: ArtifactService, fn: number): string {
  const s = svc.fn(fn);
  return [
    `fn:${s.fn} name:${s.name ?? "-"} overlayName:${s.overlayName ?? "-"}`,
    `module:${s.module ?? "-"} file:${s.file ?? "-"}${s.lines !== null ? `:${s.lines[0]}-${s.lines[1]}` : ""}`,
    `params:${s.params} kind:${s.kind}`,
    `edges in:${s.edgesIn} out:${s.edgesOut} native:${s.nativeSurfaceCount}`,
  ].join("\n");
}

function whoCallsText(svc: ArtifactService, fn: number): string {
  const r = svc.whoCalls(fn);
  const lines = r.rows.map((e) => `${typeof e.fn === "number" ? `fn:${e.fn}` : e.fn} ${e.file ?? ""}:${e.line ?? ""} ${e.kind}`);
  lines.push(`total:${r.total}`, `unknown-callee edges in scope: ${r.unknownInScope}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const hbcPath = argv.find((a) => !a.startsWith("-"));
  if (hbcPath === undefined) {
    process.stderr.write("usage: measure.ts <bundle.hbc> [--out <artifactDir>]\n");
    process.exit(2);
  }
  const bytes = readFileSync(hbcPath);
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-measure-"));

  // best-of-3 timing (§5 "same measure.ts, best-of-3").
  const N_RUNS = 3;
  let bestDecompileMs = Infinity;
  let bestIndexMs = Infinity;
  let splitResult: ReturnType<typeof splitProject> | undefined;
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now();
    const sr = splitProject(bytes, { moduleName: hbcPath });
    const t1 = performance.now();
    writeArtifact({ bytes, splitResult: sr, outDir, passes: {}, strictEnv: false, form: "flat", overwrite: true });
    const t2 = performance.now();
    bestDecompileMs = Math.min(bestDecompileMs, t1 - t0);
    bestIndexMs = Math.min(bestIndexMs, t2 - t1);
    splitResult = sr;
  }
  const renderedBytes = [...splitResult!.files.values()].reduce((a, s) => a + bytesOf(s), 0);
  const indexBytes = dirBytes(join(outDir, "index"));

  // --- decision-8 metric 2: query token cost over a fixed corpus (30 sampled
  // args per verb, deterministic — first 30 by id order, same every run). ---
  const svc = new ArtifactService(outDir);
  const functionsJsonl = readFileSync(join(outDir, "index", "functions.jsonl"), "utf8").trim().split("\n").slice(1);
  const fnIds: number[] = functionsJsonl.map((l) => (JSON.parse(l) as { fn: number }).fn);
  const withRanges = fnIds.filter((fn) => {
    try {
      svc.fn(fn);
      return true;
    } catch {
      return false;
    }
  });
  const sampleFns = withRanges.slice(0, 30);

  const fnBytes = sampleFns.map((fn) => bytesOf(fnLine(svc, fn)));
  const whoCallsBytes = sampleFns.map((fn) => bytesOf(whoCallsText(svc, fn)));

  process.stdout.write(
    [
      `=== decision-8 measured record: ${hbcPath} ===`,
      `metric 2 (query token cost, n=${sampleFns.length} sampled fns):`,
      `  fn:        median=${median(fnBytes).toFixed(0)}B  max=${Math.max(...fnBytes, 0)}B  (target: median <= 800B)`,
      `  who-calls: median=${median(whoCallsBytes).toFixed(0)}B  max=${Math.max(...whoCallsBytes, 0)}B  (target: median <= 2048B)`,
      `metric 3 (run cost, best-of-${N_RUNS}):`,
      `  decompile+render: ${bestDecompileMs.toFixed(1)}ms`,
      `  index build:      ${bestIndexMs.toFixed(1)}ms  (${((bestIndexMs / bestDecompileMs) * 100).toFixed(1)}% of decompile; target <= 25%)`,
      `  rendered source:  ${renderedBytes} bytes`,
      `  index/:           ${indexBytes} bytes  (${((indexBytes / renderedBytes) * 100).toFixed(1)}% of rendered source; target <= 30%)`,
    ].join("\n") + "\n",
  );

  rmSync(outDir, { recursive: true, force: true });
}

void main();
