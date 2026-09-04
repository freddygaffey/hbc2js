// tests/fuzz/campaign-report.test.ts — docs/BUGS.md 2026-09-03
// (`tools/fuzz/construct-fuzz.mjs:177`): the campaign driver used to
// accumulate every divergence signature into one in-memory report and
// write it with a single `JSON.stringify`, which threw
// `RangeError: Invalid string length` at campaign scale (40k programs, 201
// finds) and lost the aggregate `cells` matrix after 5h of compute.
//
// Drives `tools/fuzz/campaign-report.mjs` directly (never the whole
// driver — that would mean running hermesc/decompile per case) with a
// synthetic set of signatures large enough that a naive single-string
// write would exceed a small *injected* size limit, never by actually
// allocating hundreds of MB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — .mjs tool module, no type declarations by design.
import { createCampaignReportWriter, recountFromFinds, capPayload } from "../../tools/fuzz/campaign-report.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

test("capPayload truncates to the cap and leaves short strings alone", () => {
  assert.equal(capPayload("abc", 10), "abc");
  assert.equal(capPayload("a".repeat(20), 10), "a".repeat(10));
});

test("streams every signature to the JSONL sidecar as it is recorded, before close()", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-campaign-report-"));
  try {
    const outPath = join(dir, "report.json");
    const jsonlPath = `${outPath}.signatures.jsonl`;
    const writer = createCampaignReportWriter({ jsonlPath });
    for (let i = 0; i < 50; i++) {
      writer.recordSignature({ version: 84, seed: 1000 + i, verdict: "DIVERGENT", signature: `DIVERGENT:trace:x:shape-${i % 5}`, findPath: join(dir, `v84-seed${1000 + i}.js`), repoRoot: dir });
    }
    // Written incrementally: the JSONL already has all 50 records even
    // though close() has not been called yet.
    assert.equal(readJsonl(jsonlPath).length, 50);
    const result = writer.close({ report: { schema: "fuzz-matrix/1", component: "construct", cells: [{ name: "construct-fuzz@v84", n: 50, pass: 0, divergent: 50, error: 0, inconclusive: 0 }] }, outPath });
    assert.equal(result.signatureCount, 50);
    const summary = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(summary.schema, "fuzz-matrix/1");
    assert.equal(summary.signatureCount, 50);
    assert.equal(summary.signaturesFile, jsonlPath);
    // 50 records but only 5 distinct normalised shapes.
    assert.equal(summary.signatures.length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to a small summary (never throws / never writes an oversized file) once an injected size limit is exceeded", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-campaign-report-"));
  try {
    const outPath = join(dir, "report.json");
    const jsonlPath = `${outPath}.signatures.jsonl`;
    const writer = createCampaignReportWriter({ jsonlPath, sigCap: 5000 });
    // Many distinct long signatures — a naive single JSON.stringify of all
    // of them inline would be large; a real campaign hits V8's ~1GB
    // ceiling this way. Here we inject a tiny limit instead of allocating
    // hundreds of MB.
    for (let i = 0; i < 300; i++) {
      writer.recordSignature({ version: 96, seed: i, verdict: "ERROR", signature: `ERROR:decompile:x:${"payload".repeat(200)}-${i}`, findPath: null, repoRoot: dir });
    }
    const result = writer.close({ report: { schema: "fuzz-matrix/1", component: "construct", cells: [] }, outPath, maxInlineBytes: 2000, signaturesCap: 10 });
    assert.equal(result.signatureCount, 300);
    const summaryText = readFileSync(outPath, "utf8");
    // 300 distinct ~2100-char signatures inlined naively would be ~630,000
    // chars; the fallback keeps at most 10 of them (signaturesCap) plus a
    // fixed overhead, well under a tenth of that.
    assert.ok(summaryText.length < 100_000, `fallback summary must stay small even though 300 distinct long signatures were recorded (was ${summaryText.length} chars)`);
    const summary = JSON.parse(summaryText);
    assert.equal(summary.signaturesTruncated, true);
    assert.equal(summary.signatureCount, 300);
    assert.ok(summary.signatures.length <= 10);
    assert.equal(summary.signaturesFile, jsonlPath);
    // Nothing was lost: the full 300 records are still on disk in the JSONL.
    assert.equal(readJsonl(jsonlPath).length, 300);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recountFromFinds re-derives per-version failure counts from finds/ filenames alone, matching a real writer run", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-campaign-report-"));
  try {
    const findsDir = join(dir, "finds");
    mkdirSync(findsDir, { recursive: true });
    const seeds = { 84: [1000, 1001, 1002], 96: [2000, 2001] };
    const outPath = join(dir, "report.json");
    const writer = createCampaignReportWriter({ jsonlPath: `${outPath}.signatures.jsonl` });
    for (const [version, list] of Object.entries(seeds)) {
      for (const seed of list) {
        const findPath = join(findsDir, `v${version}-seed${seed}.js`);
        writeFileSync(findPath, "// synthetic\n");
        writer.recordSignature({ version: Number(version), seed, verdict: "DIVERGENT", signature: `DIVERGENT:trace:x:v${version}`, findPath, repoRoot: dir });
      }
    }
    const cells = { "construct-fuzz@v84": { n: 3, pass: 0, divergent: 3, error: 0, inconclusive: 0 }, "construct-fuzz@v96": { n: 2, pass: 0, divergent: 2, error: 0, inconclusive: 0 } };
    writer.close({ report: { schema: "fuzz-matrix/1", component: "construct", cells: Object.entries(cells).map(([name, c]) => ({ name, ...c })) }, outPath });

    const recount = recountFromFinds(findsDir);
    assert.equal(recount.total, 5);
    assert.equal(recount.cells["construct-fuzz@v84"], 3);
    assert.equal(recount.cells["construct-fuzz@v96"], 2);
    // The recount, derived purely from finds/ filenames, matches the
    // divergent+error counts the writer's own summary recorded.
    const summary = JSON.parse(readFileSync(outPath, "utf8"));
    for (const cell of summary.cells) {
      assert.equal(recount.cells[cell.name], cell.divergent + cell.error);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recountFromFinds on a missing directory returns an empty, non-throwing result", () => {
  assert.deepEqual(recountFromFinds(join(repoRoot, "reports", "fuzz", "definitely-does-not-exist")), { cells: {}, total: 0 });
});
