// tests/gate/ui/xref-tables.test.ts — spec 17 §14.2's bundle-wide
// object-literal inventory, surfaced as the Tables tab in the right pane
// (ui/src/panes/TablesPane.tsx, ui/src/panes/RightPane.tsx). Same style as
// tests/gate/ui/xref-strings.test.ts: pure file scanning plus dynamic
// `import()` of files with no runtime dependency on `ui/node_modules`
// (mock.ts has none — its only imports are `import type`, erased by TS
// type-stripping), so this runs under the root `npm test` gate with no
// `ui/node_modules` present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../support/paths.ts";
import { createStandardRegistry } from "../../../src/ui-core/actions.ts";
import { loadPreset, PRESET_NAMES } from "../../../src/ui-core/keymap-config.ts";
import { resolveKeymapConfigWith } from "../../../src/ui-core/keymap-resolve.ts";
import { createKeymap } from "../../../src/ui-core/keymap.ts";

const root = repoRoot();
const ui = (...p: string[]): string => join(root, "ui", ...p);
const read = (...p: string[]): string => readFileSync(ui(...p), "utf8");

// -- 1. the contract shapes exist ---------------------------------------

test("contracts.ts declares the object-tables shapes", () => {
  const src = read("src", "contracts.ts");
  for (const name of ["ObjectTableMember", "ObjectTable", "ObjectTables"]) {
    assert.match(src, new RegExp(String.raw`export (?:interface|type) ${name}\b`), `contracts.ts must export ${name}`);
  }
});

// -- 2. api.ts declares and routes objectTables --------------------------

test("api.ts declares and routes objectTables against /object-tables", () => {
  const src = read("src", "api.ts");
  assert.match(src, /objectTables\(query: ObjectTablesQuery\): Promise<ObjectTables>/);
  assert.match(src, /objectTables:\s*\(query\)\s*=>\s*get\(`\/object-tables`,\s*\{\s*\.\.\.query\s*\}\)/);
});

// -- 3. the mock adapter answers with a plausible, bounded, filterable shape

test("mockApi.objectTables returns a Bounded shape and actually filters", async () => {
  const m = await import(pathToFileURL(ui("src", "mock.ts")).href) as { mockApi: Record<string, (...a: unknown[]) => Promise<unknown>> };
  interface Member { readonly key: string; readonly value: string | null; readonly kind: string }
  interface Table { readonly fn: number; readonly fnName: string | null; readonly module: number | null; readonly members: readonly Member[]; readonly strings: number; readonly matched: number }
  interface Result { readonly tables: readonly Table[]; readonly total: number; readonly truncated: boolean; readonly scanned: number; readonly failed: number }

  const all = await m.mockApi["objectTables"]!({}) as Result;
  assert.ok(all.tables.length > 0, "the mock fixture must have at least one table matching the default filter");
  assert.equal(all.total, all.tables.length);
  assert.equal(typeof all.truncated, "boolean");
  assert.equal(typeof all.scanned, "number");
  assert.equal(typeof all.failed, "number");
  for (const t of all.tables) {
    assert.equal(typeof t.fn, "number");
    assert.ok(Array.isArray(t.members));
    // Unfiltered: `matched` is the table's own member count (spec 17
    // §14.2's ranking follow-up), never a partial hit.
    assert.equal(t.matched, t.members.length, "matched must equal members.length when neither key nor value was given");
  }
  // Sorted most-members-first when unfiltered (spec 17 §14.2).
  for (let i = 1; i < all.tables.length; i++) {
    assert.ok(all.tables[i - 1]!.members.length >= all.tables[i]!.members.length, "tables must be sorted most-members-first");
  }
  // At least one member is `kind:"computed"` with a null value, in the
  // mock fixture, so the `<computed>` rendering path is exercised.
  assert.ok(all.tables.some((t) => t.members.some((mem) => mem.kind === "computed" && mem.value === null)));

  // `value` regex actually filters, not a literal-substring fallback.
  const filtered = await m.mockApi["objectTables"]!({ value: "^https?:" }) as Result;
  assert.ok(filtered.tables.length > 0, "the mock fixture must have a table with an http(s) member");
  assert.ok(filtered.tables.every((t) => t.members.some((mem) => mem.value !== null && /^https?:/.test(mem.value))));
  assert.ok(filtered.tables.length <= all.tables.length);
  // FILTERED: `matched` counts only the members satisfying the pattern —
  // never the whole table, and always >=1 (a table that passed the filter
  // has at least one hit by construction).
  for (const t of filtered.tables) {
    const expected = t.members.filter((mem) => mem.value !== null && /^https?:/.test(mem.value)).length;
    assert.equal(t.matched, expected);
    assert.ok(t.matched >= 1);
  }
  // Ranked by `matched` (desc), same as `compareObjectTables(filtered: true)`.
  for (let i = 1; i < filtered.tables.length; i++) {
    assert.ok(filtered.tables[i - 1]!.matched >= filtered.tables[i]!.matched, "a filtered query must rank by matched first");
  }

  // `minProps` above every mock table's member count returns nothing.
  const none = await m.mockApi["objectTables"]!({ minProps: 999 }) as Result;
  assert.equal(none.tables.length, 0);

  // `minMatched` above every mock table's hit count returns nothing, even
  // though the filter itself would otherwise pass.
  const noneMatched = await m.mockApi["objectTables"]!({ value: "^https?:", minMatched: 999 }) as Result;
  assert.equal(noneMatched.tables.length, 0);
});

// -- 4. the registry action -----------------------------------------------

test("navigate.tables is a registered action reachable by chord in every preset", () => {
  const registry = createStandardRegistry();
  const action = registry.get("navigate.tables");
  assert.notEqual(action, undefined, "navigate.tables must be registered");
  assert.equal(action!.group, "navigate");
  for (const name of PRESET_NAMES) {
    const keymap = createKeymap(resolveKeymapConfigWith({ preset: name, overrides: {} }, registry, { [name]: loadPreset(name) }));
    assert.equal(typeof keymap.chordFor("navigate.tables"), "string", `preset "${name}" must bind navigate.tables to a chord`);
  }
});

test("ActionApi.showTables exists and the browser registry wires it to setRightPanel(\"tables\")", () => {
  const actions = read("..", "src", "ui-core", "actions.ts");
  assert.match(actions, /showTables\(target: Selection\): void \| Promise<void>;/);
  const registry = read("src", "actions", "registry.ts");
  assert.match(registry, /showTables:\s*\(target\)\s*=>\s*\{[^}]*setRightPanel\("tables"\)/s);
});

// -- 5. the right pane hosts the tab, on tokens only -----------------------

test("RightPane.tsx has a Tables tab that renders TablesPane, after Strings", () => {
  const src = read("src", "panes", "RightPane.tsx");
  assert.match(src, /<Tabs\.Trigger value="tables"/);
  assert.match(src, /<Tabs\.Content value="tables"[^>]*>\s*<TablesPane/);
  const stringsAt = src.indexOf('<Tabs.Trigger value="strings"');
  const tablesAt = src.indexOf('<Tabs.Trigger value="tables"');
  assert.ok(stringsAt >= 0 && tablesAt > stringsAt, "the Tables tab trigger must come after the Strings tab trigger");
});

test("TablesPane.tsx shows matched only when it narrows the member count (spec 17 §14.2 ranking follow-up)", () => {
  const src = read("src", "panes", "TablesPane.tsx");
  assert.match(src, /table\.matched\s*!==\s*table\.members\.length/, "TablesPane.tsx must gate the matched display on matched !== members.length");
});

test("TablesPane.tsx and tables-store.ts name no literal colours (tokens only)", () => {
  for (const file of ["TablesPane.tsx", "tables-store.ts"]) {
    const src = read("src", "panes", file);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b/, `${file} must not hard-code a hex colour`);
    assert.doesNotMatch(src, /\b(?:bg|text|border)-(?:slate|gray|red|blue|green)-\d/, `${file} must not use a literal Tailwind colour class`);
  }
});

// -- 6. docs -----------------------------------------------------------------

test("docs/UI.md documents the Tables tab", () => {
  const src = readFileSync(join(root, "docs", "UI.md"), "utf8");
  assert.match(src, /## Tables \(object literals\)/);
  assert.match(src, /navigate\.tables/);
});
