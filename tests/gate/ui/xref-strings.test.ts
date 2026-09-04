// tests/gate/ui/xref-strings.test.ts — spec 22 §3 "xref panels … strings/
// globals": the Strings & Globals window in the right pane
// (ui/src/panes/StringsPane.tsx, ui/src/panes/RightPane.tsx). Same style as
// tests/gate/ui/actions-registry.test.ts and tests/gate/ui/listing.test.ts:
// pure file scanning plus dynamic `import()` of files with no runtime
// dependency on `ui/node_modules` (mock.ts has none — its only imports are
// `import type`, erased by TS type-stripping), so this runs under the root
// `npm test` gate with no `ui/node_modules` present.
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

// -- 1. the contract shapes for both routes exist ----------------------------

test("contracts.ts declares the xref/string and xref/global shapes", () => {
  const src = read("src", "contracts.ts");
  for (const name of ["StringValue", "StringUseSite", "StringExact", "StringGrepRow", "StringGrep", "GlobalUse", "GlobalUses"]) {
    assert.match(src, new RegExp(String.raw`export (?:interface|type) ${name}\b`), `contracts.ts must export ${name}`);
  }
});

// -- 2. api.ts's Api surface + route table cover both routes -----------------

test("api.ts declares and routes xrefStringSearch/xrefStringUses/xrefGlobal", () => {
  const src = read("src", "api.ts");
  assert.match(src, /xrefStringSearch\(mode: "substring" \| "regex", pattern: string\): Promise<StringGrep>/);
  assert.match(src, /xrefStringUses\(sid: number\): Promise<StringExact>/);
  assert.match(src, /xrefGlobal\(name: string\): Promise<GlobalUses>/);
  // The route table: mode=exact for the single-sid lookup, mode passed
  // through for search, both against `/xref/string`; globals against
  // `/xref/global` — mirrors src/ui-server/routes.ts (spec 17 §1/§14).
  assert.match(src, /xrefStringSearch:\s*\(mode, pattern\)\s*=>\s*get\(`\/xref\/string`,\s*\{\s*mode,\s*key:\s*pattern\s*\}\)/);
  assert.match(src, /xrefStringUses:\s*\(sid\)\s*=>\s*get\(`\/xref\/string`,\s*\{\s*mode:\s*"exact",\s*key:\s*sid\s*\}\)/);
  assert.match(src, /xrefGlobal:\s*\(name\)\s*=>\s*get\(`\/xref\/global`,\s*\{\s*name\s*\}\)/);
});

// -- 3. the mock adapter answers both routes with plausible, capped data -----

test("mockApi.xrefStringSearch/xrefStringUses/xrefGlobal return Bounded shapes", async () => {
  const m = await import(pathToFileURL(ui("src", "mock.ts")).href) as { mockApi: Record<string, (...a: unknown[]) => Promise<unknown>> };
  const grep = await m.mockApi["xrefStringSearch"]!("substring", "licence") as { rows: { sid: number; head: string; uses: number }[]; total: number; truncated: boolean };
  assert.ok(grep.rows.length > 0, "the mock string table must have at least one string matching \"licence\"");
  for (const r of grep.rows) {
    assert.equal(typeof r.sid, "number");
    assert.equal(typeof r.head, "string");
    assert.equal(typeof r.uses, "number");
  }
  assert.equal(grep.total, grep.rows.length);
  assert.equal(typeof grep.truncated, "boolean");

  const sid = grep.rows[0]!.sid;
  const exact = await m.mockApi["xrefStringUses"]!(sid) as { value: unknown; uses: { rows: { sid: number; fn: number; role: string; n: number }[]; total: number; truncated: boolean } };
  assert.notEqual(exact.value, undefined, "mode=exact must resolve the same sid the search hit reported");
  assert.ok(Array.isArray(exact.uses.rows));
  for (const u of exact.uses.rows) {
    assert.equal(u.sid, sid);
    assert.equal(typeof u.fn, "number");
  }

  const globals = await m.mockApi["xrefGlobal"]!("console") as { rows: { fn: number; access: string; n: number; file: string | null; line: number | null }[]; total: number; truncated: boolean };
  assert.ok(Array.isArray(globals.rows));
  assert.equal(globals.total, globals.rows.length);

  // Regex mode must actually behave like a regex, not a literal-substring
  // fallback re-used under a different name.
  const regexHit = await m.mockApi["xrefStringSearch"]!("regex", "^token$") as { rows: unknown[] };
  const literalMiss = await m.mockApi["xrefStringSearch"]!("substring", "^token$") as { rows: unknown[] };
  assert.ok(regexHit.rows.length > 0, "regex mode must match the exact-anchor pattern against a real mock string");
  assert.equal(literalMiss.rows.length, 0, "substring mode must treat \"^token$\" as a literal, matching nothing");
});

// -- 4. the registry action ---------------------------------------------------

test("navigate.strings is a registered action reachable by chord in every preset", () => {
  const registry = createStandardRegistry();
  const action = registry.get("navigate.strings");
  assert.notEqual(action, undefined, "navigate.strings must be registered");
  assert.equal(action!.group, "navigate");
  for (const name of PRESET_NAMES) {
    const keymap = createKeymap(resolveKeymapConfigWith({ preset: name, overrides: {} }, registry, { [name]: loadPreset(name) }));
    assert.equal(typeof keymap.chordFor("navigate.strings"), "string", `preset "${name}" must bind navigate.strings to a chord`);
  }
});

test("ActionApi.showStrings exists and the browser registry wires it to setRightPanel(\"strings\")", () => {
  const actions = read("..", "src", "ui-core", "actions.ts");
  assert.match(actions, /showStrings\(target: Selection\): void \| Promise<void>;/);
  const registry = read("src", "actions", "registry.ts");
  assert.match(registry, /showStrings:\s*\(target\)\s*=>\s*\{[^}]*setRightPanel\("strings"\)/s);
});

// -- 5. the right pane hosts the tab, on tokens only --------------------------

test("RightPane.tsx has a Strings tab that renders StringsPane", () => {
  const src = read("src", "panes", "RightPane.tsx");
  assert.match(src, /<Tabs\.Trigger value="strings"/);
  assert.match(src, /<Tabs\.Content value="strings"[^>]*>\s*<StringsPane/);
});

test("StringsPane.tsx and strings-store.ts name no literal colours (tokens only)", () => {
  for (const file of ["StringsPane.tsx", "strings-store.ts"]) {
    const src = read("src", "panes", file);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b/, `${file} must not hard-code a hex colour`);
    assert.doesNotMatch(src, /\b(?:bg|text|border)-(?:slate|gray|red|blue|green)-\d/, `${file} must not use a literal Tailwind colour class`);
  }
});
