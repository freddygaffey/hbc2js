#!/usr/bin/env node
// tools/secrets/measure.ts — spec 12 §7/§9 step 4: the decision-8 quadruple
// for the secrets indexer (recall per tier, FP/1k, cold/warm wall-time).
// `--json` prints the machine-readable shape T5/T8 (tests/secrets/
// measure-gate.test.ts, tests/secrets/held-out.test.ts) assert against;
// without it, prints the same numbers as human-readable lines.
//
// Recall (§7.1.1): computed by running the pure `classify()` (src/secrets/
// classify.ts) directly over every `tests/fixtures/secrets/seeded/
// ground-truth.json` value — same technique as
// tests/secrets/classifier-recall.test.ts (T2), which already proved this
// is the right measurement surface for the ctx-gated patterns' §3.4 proxy.
//
// FP rate (§7.1.2) + cold/warm wall-time (§7.1.3, §6): run the real
// `SecretsService` scan driver end to end. The tuning-corpus FP number
// (§7.4) is measured on the rn-template bundle
// (tests/fixtures/bundles/rn-template-0.72/index.android.hbc, checked in) —
// a real artifact is built for it with `splitProject`/`writeArtifact`
// (same pipeline as tools/artifact/measure.ts), then `SecretsService` is
// pointed at that artifact's ROOT (it resolves `index/strings.json`/
// `index/string-uses.jsonl` itself, spec 10 §2.3's actual on-disk path).
// No allowlist review of rn-template's
// strings has been done in this pass (out of scope for this tool's landing
// — the number below is the RAW active tier A/B/C finding count with zero
// hand-curated exclusions); the landing report states this plainly rather
// than tuning a threshold to make it look reviewed (R4).
//
// Cold/warm wall-time (§6's bound) is measured on the materialized SEEDED
// artifact (tests/fixtures/secrets/seeded/, ~200 strings) per this tool's
// brief — NOT at the "4k-function bundle" scale §6/§7.2 actually specify
// the bound for. This is a stated deviation, not a silent substitution: the
// rn-template-scale artifact IS built by this same tool for the FP number
// above, so a truer §6 timing (on that artifact) is one line away; it is
// not wired into `wallTimeMs` here because the brief this tool shipped
// under asked for the seeded-artifact number specifically. See the landing
// report.
//
// `--held-out <bundle.hbc>` (T8): builds a real artifact for the given
// bundle and reports ONLY `fpPer1k.heldOut` on it, never tuned against —
// spec 12 §7.4's promote-and-replace rule applies if this number is ever
// used to steer a pattern/threshold change.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitProject } from "../../src/split/index.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { SecretsService } from "../../src/secrets/service.ts";
import { classify } from "../../src/secrets/classify.ts";
import { materializeArtifact, loadGroundTruth } from "../../tests/secrets/support/materialize.ts";

const RN_TEMPLATE_HBC = fileURLToPath(
  new URL("../../tests/fixtures/bundles/rn-template-0.72/index.android.hbc", import.meta.url),
);

interface Quadruple {
  recall: { tierA: number; overall: number };
  fpPer1k: { tuning: number; heldOut?: number };
  wallTimeMs: { cold: number; warm: number };
}

function computeRecall(): { tierA: number; overall: number } {
  const gt = loadGroundTruth();
  let foundA = 0;
  let totalA = 0;
  let foundAll = 0;
  // Same exclusion as T2 (tests/secrets/classifier-recall.test.ts): rows
  // with tier "-" are tag-category ground truth (endpoint/sql/…), not
  // secret findings — classify() never sets a `.tier` for them by design
  // (module header, tag-only categories), so counting them here would
  // silently punish recall for something the classifier was never asked to
  // hit as a *secret*.
  const rows = gt.secrets.filter((s) => s.tier !== "-");
  for (const s of rows) {
    if (s.tier === "A") totalA++;
    const hits = classify(s.value);
    const match = hits.some((h) => h.patternId === s.patternId && h.tier === s.tier);
    if (match) {
      foundAll++;
      if (s.tier === "A") foundA++;
    }
  }
  return {
    tierA: totalA === 0 ? 1 : foundA / totalA,
    overall: rows.length === 0 ? 1 : foundAll / rows.length,
  };
}

/** Build a real spec-10 artifact for `hbcPath` into a fresh tmpdir and
 *  return the artifact ROOT `SecretsService` should be pointed at (its
 *  `artifactDir` reads `index/strings.json`/`index/string-uses.jsonl`
 *  itself, spec 10 §2.3). */
function buildArtifactRootDir(hbcPath: string): string {
  const bytes = readFileSync(hbcPath);
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-secrets-measure-"));
  const sr = splitProject(bytes, { moduleName: hbcPath });
  writeArtifact({ bytes, splitResult: sr, outDir, passes: {}, strictEnv: false, form: "flat", overwrite: true });
  return outDir;
}

/** FP rate (§7.1.2): active tier A/B/C finding count over a fresh scan,
 *  per 1,000 strings scanned. No allowlist subtraction (see module header). */
function fpPer1kOnBundle(hbcPath: string): number {
  const rootDir = buildArtifactRootDir(hbcPath);
  const svc = new SecretsService({ artifactDir: rootDir });
  svc.scan({ force: true });
  const findings = svc.list();
  const strings = JSON.parse(readFileSync(join(rootDir, "index", "strings.json"), "utf8")) as { entries: unknown[] };
  const total = strings.entries.length;
  return total === 0 ? 0 : (findings.length / total) * 1000;
}

function computeColdWarm(): { cold: number; warm: number } {
  const dir = materializeArtifact() + "/";
  const cold = new SecretsService({ artifactDir: dir });
  const t0 = performance.now();
  cold.scan({ force: true });
  const t1 = performance.now();
  const warm = new SecretsService({ artifactDir: dir });
  const t2 = performance.now();
  warm.scan({ force: false });
  const t3 = performance.now();
  return { cold: t1 - t0, warm: t3 - t2 };
}

function main(): void {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const heldOutIdx = argv.indexOf("--held-out");
  const heldOutPath = heldOutIdx >= 0 ? argv[heldOutIdx + 1] : undefined;

  const recall = computeRecall();
  const tuningFp = existsSync(RN_TEMPLATE_HBC) ? fpPer1kOnBundle(RN_TEMPLATE_HBC) : 0;
  const wallTimeMs = computeColdWarm();
  const out: Quadruple = { recall, fpPer1k: { tuning: tuningFp }, wallTimeMs };

  if (heldOutPath !== undefined) {
    if (!existsSync(heldOutPath)) {
      process.stderr.write(`--held-out bundle not found: ${heldOutPath}\n`);
      process.exit(2);
    }
    out.fpPer1k.heldOut = fpPer1kOnBundle(heldOutPath);
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(out) + "\n");
  } else {
    process.stdout.write(`recall tierA=${(recall.tierA * 100).toFixed(1)}% overall=${(recall.overall * 100).toFixed(1)}%\n`);
    process.stdout.write(`fp/1k tuning=${tuningFp.toFixed(2)}${out.fpPer1k.heldOut !== undefined ? ` heldOut=${out.fpPer1k.heldOut.toFixed(2)}` : ""}\n`);
    process.stdout.write(`wall-time cold=${wallTimeMs.cold.toFixed(1)}ms warm=${wallTimeMs.warm.toFixed(1)}ms\n`);
  }
}

main();
