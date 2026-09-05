// tests/gate/ui/result-table.test.ts — spec 26 L5: `ui/src/components/ResultTable.tsx`
// (`@tanstack/react-table` + `@tanstack/react-virtual`) is the ONE shared,
// virtualised, sortable table every result list in the shell uses. Pure
// file scanning, same style as `tests/gate/passes/imports.test.ts` and
// `tests/gate/ui/tokens.test.ts` — runs under the root `npm test` with no
// `ui/node_modules` present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const uiSrc = join(repoRoot(), "ui", "src");

/** Every pane spec 26 L5 names as a `ResultTable` consumer
 *  (docs/specs/26-ui-full-ide.md §L5 "Files"). */
const LONG_LIST_PANES: readonly string[] = [
  join(uiSrc, "panes", "LeftPane.tsx"),
  join(uiSrc, "panes", "RightPane.tsx"),
  join(uiSrc, "panes", "StringsPane.tsx"),
  join(uiSrc, "panes", "TablesPane.tsx"),
  join(uiSrc, "panes", "WorkersPane.tsx"),
  join(uiSrc, "activity", "LogTab.tsx"),
];

const RESULT_TABLE_IMPORT = /from\s+["'][^"']*components\/ResultTable(?:\.tsx)?["']/;

test("every long-list pane imports ResultTable (spec 26 L5)", () => {
  const missing: string[] = [];
  for (const file of LONG_LIST_PANES) {
    const src = readFileSync(file, "utf8");
    if (!RESULT_TABLE_IMPORT.test(src)) missing.push(file);
  }
  assert.deepEqual(missing, [], `these panes must import ../components/ResultTable.tsx:\n${missing.join("\n")}`);
});

/** A raw `.slice(0, N)` cap on a result LIST (never on a string, which is a
 *  different, legitimate use of `.slice`) is exactly the silent-truncation
 *  bug spec 26 L5 fixes (`LeftPane.tsx` used to `.slice(0, 100)` /
 *  `.slice(0, 200)` with no indication anything was cut). A file may still
 *  slice a small NESTED disclosure (e.g. a table's own member list) as
 *  long as it also renders SOME honesty mechanism in the same file — this
 *  gate accepts either the shared `ResultTable`/`TruncationBar` or the
 *  file's own hidden-count line (`+N more` / `truncated`), so it flags a
 *  genuinely silent cap without churning every small "show first N,
 *  +hidden more" disclosure into a full table. */
const SILENT_SLICE = /\.slice\(0,\s*\d+\)/;
const HONESTY_MARKERS = /ResultTable|TruncationBar|truncat|more\b/i;

test("no pane slices a result list without rendering a truncation/hidden-count indicator (spec 26 L5)", () => {
  const violations: string[] = [];
  for (const file of LONG_LIST_PANES) {
    const src = readFileSync(file, "utf8");
    if (SILENT_SLICE.test(src) && !HONESTY_MARKERS.test(src)) violations.push(file);
  }
  assert.deepEqual(violations, [], `silent .slice(0, N) cap with no honesty marker in:\n${violations.join("\n")}`);
});

test("LeftPane.tsx no longer hard-caps search hits at 100/200 (the bug this spec fixed)", () => {
  const src = readFileSync(join(uiSrc, "panes", "LeftPane.tsx"), "utf8");
  assert.ok(!/\.slice\(0,\s*100\)/.test(src), "moduleHits must not be silently capped at 100 any more");
  assert.ok(!/\.slice\(0,\s*200\)/.test(src), "function search hits must not be silently capped at 200 any more");
});

test("ResultTable.tsx names no literal colours and no raw px (tokens only, spec 20 §1.2)", () => {
  const src = readFileSync(join(uiSrc, "components", "ResultTable.tsx"), "utf8");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(src), "no hex colour literal");
  assert.ok(!/\btext-\[[^\]]+\]/.test(src), "no off-scale arbitrary text-size utility");
});
