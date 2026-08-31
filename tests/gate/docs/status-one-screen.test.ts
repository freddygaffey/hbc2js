// docs/CONSOLIDATION.md item 14: "STATUS.md -> one screen, fixed template
// (milestones, gate numbers, open bugs, blocked, decisions needed); narrative
// -> AGENT-LOG." STATUS.md had grown to 1051 lines of accreted narrative
// (archived verbatim to docs/STATUS-ARCHIVE.md). This gate test keeps the
// rewritten STATUS.md from drifting back into a narrative dump: it must stay
// short, keep its fixed section order, and every numeric cell in the
// Scoreboard table must carry a source in the same row (no un-cited number).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const statusPath = join(repoRoot(), "docs", "STATUS.md");
const text = readFileSync(statusPath, "utf8");
const lines = text.split("\n");

test("STATUS.md is at most 100 lines", () => {
  assert.ok(
    lines.length <= 100,
    `STATUS.md is ${lines.length} lines; the one-screen template caps it at 100 (docs/CONSOLIDATION.md item 14). Long-form history belongs in docs/STATUS-ARCHIVE.md.`,
  );
});

// The fixed template's headings, in the order docs/CONSOLIDATION.md item 14 /
// the QUEUE item 2 brief specify. Matched as a prefix of a "## " line so the
// heading may carry extra words (e.g. "## Ladder -- 12/30 rungs live").
const REQUIRED_HEADINGS = [
  "Scoreboard",
  "Milestones",
  "Ladder",
  "Gate",
  "Open bugs",
  "Blocked",
  "Queue",
];

test("STATUS.md contains the fixed template headings, in order", () => {
  const headingLines = lines
    .filter((l) => l.startsWith("## "))
    .map((l) => l.slice(3).trim());

  let cursor = 0;
  for (const want of REQUIRED_HEADINGS) {
    const idx = headingLines.findIndex(
      (h, i) => i >= cursor && h.startsWith(want),
    );
    assert.ok(
      idx >= 0,
      `STATUS.md is missing the "## ${want}" section (or it is out of order). Found headings: ${JSON.stringify(headingLines)}`,
    );
    cursor = idx + 1;
  }
});

test("STATUS.md opens with a one-line product goal before the Scoreboard", () => {
  const scoreboardIdx = lines.findIndex((l) => l.startsWith("## Scoreboard"));
  assert.ok(scoreboardIdx > 0, "no ## Scoreboard heading found");
  const before = lines.slice(0, scoreboardIdx).join("\n");
  assert.match(
    before,
    /goal/i,
    "expected a one-line product goal before the Scoreboard section (docs/LANES.md defines the product)",
  );
});

test("every numeric Scoreboard cell carries a source in its own row", () => {
  const start = lines.findIndex((l) => l.startsWith("## Scoreboard"));
  assert.ok(start >= 0, "no ## Scoreboard heading found");
  const rest = lines.slice(start + 1);
  const tableEnd = rest.findIndex((l) => l.startsWith("## "));
  const tableLines = (tableEnd >= 0 ? rest.slice(0, tableEnd) : rest).filter(
    (l) => l.trim().startsWith("|"),
  );
  // First row is the header, second is the "|---|" separator.
  const dataRows = tableLines.slice(2);
  assert.ok(dataRows.length >= 5, "expected at least 5 Scoreboard data rows (stages 1-5)");

  for (const row of dataRows) {
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    // Last column is "source" per the fixed template.
    const source = cells[cells.length - 1] ?? "";
    const bodyCells = cells.slice(0, -1);
    const hasDigit = bodyCells.some((c) => /\d/.test(c));
    if (hasDigit) {
      assert.ok(
        source.length > 0,
        `Scoreboard row has a numeric cell but no source: ${row}`,
      );
    }
  }
});
