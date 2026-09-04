// tests/fuzz/diff-signatures.test.ts — docs/fuzz/CONSTRUCT-FUZZER.md
// "Morning after a campaign". Exercises tools/fuzz/diff-signatures.mjs
// against tiny synthetic campaign dirs (never a real campaign — this must
// stay fast and hermetic) and its --extract mode against a small markdown
// excerpt shaped like docs/reports/2026-09-04-finds-retriage-postfix.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tool = join(repoRoot, "tools", "fuzz", "diff-signatures.mjs");
const known = JSON.parse(readFileSync(join(repoRoot, "tools", "fuzz", "known-signatures.json"), "utf8"));

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, [tool, ...args], { encoding: "utf8", cwd: repoRoot });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function makeCampaign(dir: string, cell: Record<string, unknown>, signatures: string[], finds: string[]): void {
  mkdirSync(join(dir, "reports"), { recursive: true });
  mkdirSync(join(dir, "finds"), { recursive: true });
  writeFileSync(
    join(dir, "reports", "r1.json"),
    JSON.stringify({
      schema: "fuzz-matrix/1",
      component: "construct",
      date: new Date().toISOString(),
      runId: "test-run",
      grammarVersion: "0.1.0",
      seedRanges: [{ version: 84, kind: "work", start: 1, end: 100 }],
      cells: [cell],
      signatures,
    }),
  );
  for (const f of finds) writeFileSync(join(dir, "finds", f), "// synthetic fuzz find\n");
}

test("classifies a known signature as KNOWN and an unseen one as NEW", () => {
  const root = mkdtempSync(join(tmpdir(), "hbc2js-diffsig-"));
  try {
    const knownKey = known[0].key as string;
    const camp = join(root, "campaign2-v84-1000000");
    makeCampaign(
      camp,
      { name: "construct-fuzz@v84", n: 20, pass: 15, divergent: 3, inconclusive: 0, error: 2, mode: "full-ladder" },
      [knownKey, "DIVERGENT:trace:trace:totally-novel-shape-#-not-seen-before"],
      ["v84-seed1.js", "v84-seed2.js"],
    );
    const outPath = join(root, "out.md");
    const r = run([camp, "--out", outPath]);
    assert.equal(r.status, 0, r.stderr);
    const report = readFileSync(outPath, "utf8");

    // Per-version table row.
    assert.match(report, /\| v84 \| full-ladder \| 20 \| 15 \| 3 \| 2 \| 0 \| 75\.0% \|/);

    // NEW section names the novel signature and NOT the known one.
    assert.match(report, /## NEW signatures \(1\)/);
    assert.match(report, /totally-novel-shape/);
    const newSection = report.split("## NEW signatures")[1]?.split("## KNOWN")[0] ?? "";
    assert.doesNotMatch(newSection, /DIVERGENT:trace:trace:total=#/);

    // KNOWN section reports the one known signature still firing.
    assert.match(report, new RegExp(`## KNOWN signatures still firing \\(1 of ${known.length}\\)`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aggregates programs/pass/divergent/error across two campaign dirs", () => {
  const root = mkdtempSync(join(tmpdir(), "hbc2js-diffsig-agg-"));
  try {
    const campA = join(root, "campaign2-v84-1000000");
    const campB = join(root, "campaign2-v84-2000000");
    makeCampaign(campA, { name: "construct-fuzz@v84", n: 10, pass: 10, divergent: 0, inconclusive: 0, error: 0, mode: "full-ladder" }, [], []);
    makeCampaign(campB, { name: "construct-fuzz@v84", n: 10, pass: 7, divergent: 2, inconclusive: 0, error: 1, mode: "full-ladder" }, [], []);
    const outPath = join(root, "out.md");
    const r = run([campA, campB, "--out", outPath]);
    assert.equal(r.status, 0, r.stderr);
    const report = readFileSync(outPath, "utf8");
    assert.match(report, /Reports read: 2; programs: 20\./);
    assert.match(report, /\| v84 \| full-ladder \| 20 \| 17 \| 2 \| 1 \| 0 \| 85\.0% \|/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--extract pulls signature keys out of a retriage-report excerpt", () => {
  const root = mkdtempSync(join(tmpdir(), "hbc2js-diffsig-extract-"));
  try {
    const mdPath = join(root, "2026-09-04-tiny-excerpt.md");
    writeFileSync(
      mdPath,
      [
        "# tiny excerpt",
        "",
        "## Surviving signatures",
        "",
        "- `DIVERGENT:trace:trace:foo=#\nbar=#` — DIVERGENT, 3 find(s), version(s) 84,94, example `v84-seed1.js` — some detail text here",
        "- `ERROR:syntax:parse:unexpected token` — ERROR, 1 find(s), version(s) 99, example `v99-seed2.js` — hermesc rejected",
        "",
      ].join("\n"),
    );
    const outPath = join(root, "known.json");
    const r = run(["--extract", mdPath, "--out", outPath]);
    assert.equal(r.status, 0, r.stderr);
    const entries = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(entries.length, 2);
    assert.equal(entries[0].key, "DIVERGENT:trace:trace:foo=#\nbar=#");
    assert.deepEqual(entries[0].versions, [84, 94]);
    assert.equal(entries[0].example, "v84-seed1.js");
    assert.equal(entries[0].firstSeen, "2026-09-04");
    assert.equal(entries[0].status, "open");
    assert.equal(entries[1].key, "ERROR:syntax:parse:unexpected token");
    assert.deepEqual(entries[1].versions, [99]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("known-signatures.json has 64 entries extracted from the 2026-09-04 retriage report", () => {
  assert.equal(known.length, 64);
  for (const e of known) {
    assert.equal(typeof e.key, "string");
    assert.equal(e.status, "open");
    assert.ok(Array.isArray(e.versions));
  }
});
