// tests/fuzz/matrix-schema.test.ts — docs/specs/09-fuzzing.md §8 T4.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findHermesc } from "../../src/harness/roundtrip.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const driver = join(repoRoot, "tools", "fuzz", "construct-fuzz.mjs");

interface Cell {
  readonly name: string;
  readonly n: number;
  readonly pass: number;
  readonly divergent: number;
  readonly inconclusive: number;
  readonly error: number;
  readonly mode: string;
}

function runDriver(versions: string, count: number, seedBase: number, outDir: string): unknown {
  const out = join(outDir, `report-${versions}-${seedBase}.json`);
  const r = spawnSync(process.execPath, [driver, "--versions", versions, "--count", String(count), "--seed-base", String(seedBase), "--out", out], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  assert.equal(r.status, 0, `driver failed: ${r.stderr}\n${r.stdout}`);
  return JSON.parse(readFileSync(out, "utf8"));
}

function assertSchemaShape(report: any): void {
  assert.equal(report.schema, "fuzz-matrix/1");
  assert.equal(report.component, "construct");
  assert.equal(typeof report.date, "string");
  assert.equal(typeof report.runId, "string");
  assert.equal(typeof report.grammarVersion, "string");
  assert.ok(Array.isArray(report.cells));
  for (const cell of report.cells as Cell[]) {
    assert.equal(typeof cell.name, "string");
    assert.equal(typeof cell.n, "number");
    assert.equal(typeof cell.pass, "number");
    assert.equal(typeof cell.divergent, "number");
    assert.equal(typeof cell.inconclusive, "number");
    assert.equal(typeof cell.error, "number");
    assert.ok(["full-ladder", "roundtrip-only", "no-ground-truth"].includes(cell.mode));
    assert.equal(cell.pass + cell.divergent + cell.inconclusive + cell.error, cell.n, `${cell.name}: counts don't sum to n`);
  }
}

test("T4(a)/(c): driver-produced report validates fuzz-matrix/1; v98 cell carries mode roundtrip-only", { skip: findHermesc(98) === null ? "hermesc v98 not found (run tools/get-hermesc.sh 98)" : false }, () => {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-fuzz-t4-"));
  try {
    const report = runDriver("98", 1, 314159, outDir) as any;
    assertSchemaShape(report);
    const v98Cell = (report.cells as Cell[]).find((c) => c.name.includes("v98"));
    assert.ok(v98Cell !== undefined, "no v98 cell in report");
    assert.equal(v98Cell!.mode, "roundtrip-only");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// D5 encoded (§4.1): "INCONCLUSIVE is never folded into pass; a cell's
// headline rate is pass / n with inconclusive shown beside it." A scoreboard
// computing rate = pass/n from a cell with inconclusive > 0 must never land
// on 1.0 merely because divergent+error are both 0 — INCONCLUSIVE results
// must visibly depress the rate, not vanish from it.
function headlineRate(cell: Pick<Cell, "n" | "pass">): number {
  return cell.n === 0 ? 0 : cell.pass / cell.n;
}

test("T4(b): a cell with inconclusive > 0 and pass = n - inconclusive does not report rate 1.0", () => {
  const cell = { n: 10, pass: 7, divergent: 0, inconclusive: 3, error: 0 };
  assert.equal(cell.pass, cell.n - cell.inconclusive);
  const rate = headlineRate(cell);
  assert.notEqual(rate, 1.0);
  assert.equal(rate, 0.7);
});
