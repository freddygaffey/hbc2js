// docs/QUEUE.md "## Now" — METRICS SCOREBOARD. Structural checks only (no
// exact-output assertions on a table whose values change every run — see
// CLAUDE.md testing rules / tests/gate/docs/testing-rules.test.ts): the
// scoreboard file exists and parses as a markdown table with >=1 row, and
// the collector script (tools/metrics/collect.mjs) is syntactically valid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const root = repoRoot();
const scoreboardPath = join(root, "docs", "reports", "metrics", "scoreboard.md");
const collectorPath = join(root, "tools", "metrics", "collect.mjs");

test("metrics scoreboard file exists", () => {
  assert.ok(existsSync(scoreboardPath), `expected ${scoreboardPath} to exist`);
});

test("metrics scoreboard parses as a markdown table with a header, a separator, and >=1 data row", () => {
  const text = readFileSync(scoreboardPath, "utf8");
  const rowLines = text.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| ---"));
  // First "| " line is the header row; every remaining one is a data row.
  assert.ok(rowLines.length >= 2, "expected a header row plus at least one data row");
  const headerLine = rowLines[0];
  assert.ok(headerLine !== undefined, "expected a header row");
  const headerCells = headerLine
    .split("|")
    .map((c) => c.trim())
    .filter((c) => c !== "");
  assert.ok(headerCells.includes("date"), "expected a 'date' column in the header");
  const dataRows = rowLines.slice(1);
  assert.ok(dataRows.length >= 1, "expected at least one data row");
  for (const row of dataRows) {
    const cells = row
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c !== "");
    assert.equal(cells.length, headerCells.length, `row cell count must match header cell count: ${row}`);
    const dateCell = cells[0];
    assert.ok(dateCell !== undefined, `expected a first cell: ${row}`);
    assert.match(dateCell, /^\d{4}-\d{2}-\d{2}$/, `expected the first cell to be a YYYY-MM-DD date: ${row}`);
  }
});

test("metrics collector script (tools/metrics/collect.mjs) passes node --check", () => {
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ["--check", collectorPath], { cwd: root });
  }, "expected tools/metrics/collect.mjs to be syntactically valid");
});

test("metrics collector's --dry-run produces a well-formed table row without writing the scoreboard", () => {
  const before = readFileSync(scoreboardPath, "utf8");
  const out = execFileSync(process.execPath, [collectorPath, "--dry-run"], { cwd: root, encoding: "utf8" });
  const after = readFileSync(scoreboardPath, "utf8");
  assert.equal(after, before, "--dry-run must never write the scoreboard file");
  assert.match(out.trim(), /^\| \d{4}-\d{2}-\d{2} \|/, `expected a markdown table row starting with a date, got: ${out}`);
});
