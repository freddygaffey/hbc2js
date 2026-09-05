// tests/gate/ui/search-limit.test.ts — regression for docs/BUGS.md
// "the UI's search box sends no ?limit=": `search/functions` (TopBar's live
// type-ahead box) and `search/source` (src/mcp/leads.ts, not yet called from
// any pane) both accept a bounded `limit` (spec 22 §14 addition 3) and, for
// `search/source`, push it into the scan itself so a keystroke never grep's
// every function's rendered source (docs/BUGS.md, commit 5908aee). Pure file
// scanning, like tests/gate/ui/xref-strings.test.ts: no ui/node_modules
// needed, and it survives a rewrite of TopBar's markup because it asserts on
// api.ts's request shape and hooks.ts's call site, not rendered output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const root = repoRoot();
const ui = (...p: string[]): string => join(root, "ui", ...p);
const read = (...p: string[]): string => readFileSync(ui(...p), "utf8");

const apiSrc = read("src", "api.ts");
const hooksSrc = read("src", "hooks.ts");
const topBarSrc = read("src", "panes", "TopBar.tsx");
const contractsSrc = read("src", "contracts.ts");

test("SearchPage carries an optional partial flag, mirroring src/mcp/leads.ts", () => {
  assert.match(contractsSrc, /interface SearchPage<T>/);
  const body = contractsSrc.slice(contractsSrc.indexOf("interface SearchPage<T>"));
  assert.match(body.slice(0, body.indexOf("}")), /partial\?:\s*true/);
});

test("api.ts's searchFunctions and searchSource both take a limit and forward it to the query string", () => {
  assert.match(apiSrc, /searchFunctions\(query: string, cursor\?: number, limit\?: number\)/);
  assert.match(apiSrc, /searchSource\(query: string, cursor\?: number, limit\?: number\)/);
  assert.match(apiSrc, /searchFunctions:\s*\(query, cursor, limit\)\s*=>\s*get\(`\/search\/functions`,\s*\{\s*q:\s*query,\s*cursor,\s*limit\s*\}\)/);
  assert.match(apiSrc, /searchSource:\s*\(query, cursor, limit\)\s*=>\s*get\(`\/search\/source`,\s*\{\s*q:\s*query,\s*cursor,\s*limit\s*\}\)/);
});

test("the live type-ahead box (useSearchFunctions) sends SEARCH_TYPEAHEAD_LIMIT, not an unbounded query", () => {
  assert.match(
    hooksSrc,
    /api\.searchFunctions\(query,\s*undefined,\s*SEARCH_TYPEAHEAD_LIMIT\)/,
    "useSearchFunctions must pass a bounded limit — one keystroke must never ask the server to scan without a cap",
  );
});

test("TopBar shows a partial-scan affordance distinct from the exact 'N more not shown' count", () => {
  assert.match(topBarSrc, /hits\.data\?\.partial === true/);
  assert.match(topBarSrc, /more matches than shown/i);
});
