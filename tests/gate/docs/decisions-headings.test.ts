// Issue #1 follow-up: docs/DECISIONS.md numbers decisions D1, D2, ... (plus
// lettered amendments like D12a) and instructs "never delete, mark superseded
// instead" — so a duplicate `## Dnn` heading is always a mistake (a copy-paste
// that forgot to renumber, or two agents claiming the same id), never a
// legitimate second heading. This is a docs/DECISIONS.md-only lint; it says
// nothing about ordering or about whether an id was skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const HEADING_RE = /^##\s+(D\d+[a-z]?)\b/;

function decisionHeadingIds(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split("\n")) {
    const m = HEADING_RE.exec(line);
    if (m?.[1] !== undefined) ids.push(m[1]);
  }
  return ids;
}

test("docs/DECISIONS.md: no two decisions share a `## Dnn` heading id", () => {
  const text = readFileSync(join(repoRoot(), "docs", "DECISIONS.md"), "utf8");
  const ids = decisionHeadingIds(text);

  assert.ok(ids.length > 0, "expected at least one `## Dnn — ...` heading in docs/DECISIONS.md");

  const seen = new Map<string, number>();
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);

  assert.deepEqual(
    duplicates,
    [],
    `duplicate decision heading id(s) in docs/DECISIONS.md: ${duplicates.join(", ")} — ` +
      `never delete/reuse a decision id, mark it superseded instead (see file header)`,
  );
});

test("decisionHeadingIds: sanity check against a minimal fixture", () => {
  const ids = decisionHeadingIds(
    [
      "# Architecture decisions",
      "",
      "## D1 — First (2026-08-30)",
      "body text, not a heading",
      "## D1a — Amendment (2026-08-30)",
      "## D2 — Second (2026-08-30)",
    ].join("\n"),
  );
  assert.deepEqual(ids, ["D1", "D1a", "D2"]);
});

test("decisionHeadingIds: catches an actual duplicate", () => {
  const ids = decisionHeadingIds(
    ["## D1 — First (2026-08-30)", "## D2 — Second (2026-08-30)", "## D1 — Reused by mistake (2026-08-30)"].join(
      "\n",
    ),
  );
  const seen = new Map<string, number>();
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  assert.deepEqual(
    [...seen.entries()].filter(([, c]) => c > 1).map(([id]) => id),
    ["D1"],
  );
});
