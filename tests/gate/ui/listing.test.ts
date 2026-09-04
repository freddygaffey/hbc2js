// tests/gate/ui/listing.test.ts — wave-2 track 1 (the listing) invariants.
//
// Two rules the shell cannot be allowed to lose:
//   1. `ui/src/listing/**` names no colours. CodeMirror ships its own
//      palette; the listing dresses it through `EditorView.theme` with
//      `var(--token)` values only (spec 20 §1.2, spec 22 §3.4). This is the
//      same rule tests/gate/ui/tokens.test.ts enforces shell-wide, asserted
//      again here so a future "just this once" hex in the editor theme
//      fails a test named after the thing it broke.
//   2. `ui/src/state/selection.ts` stays a structural copy of `Selection` in
//      src/ui-core/actions.ts. Every action reads `ActionContext.selection`;
//      if the store drops a field (or renames one), the action registry gets
//      an object it cannot act on and nothing fails until a human clicks.
//
// Pure file scanning plus a dynamic import of the pure helpers: this test
// runs under the root `npm test` with no `ui/node_modules` present, exactly
// like tests/gate/passes/imports.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../support/paths.ts";

const root = repoRoot();
const listingDir = join(root, "ui", "src", "listing");
const selectionFile = join(root, "ui", "src", "state", "selection.ts");
const actionsFile = join(root, "src", "ui-core", "actions.ts");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|css)$/.test(entry)) out.push(p);
  }
  return out;
}

// -- 1. the listing names no colours ----------------------------------------

const COLOUR_RULES: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: "hex colour literal", re: /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-fA-F\w-])/g },
  { name: "css colour function", re: /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(/g },
  {
    name: "tailwind literal colour class",
    re: /\b(?:bg|text|border|ring|fill|stroke|from|via|to|decoration|outline|shadow|accent|caret|divide|placeholder)-(?:slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)(?:-(?:50|[1-9]00|950))?\b/g,
  },
];

test("ui/src/listing/** contains no literal colours (tokens only)", () => {
  const files = walk(listingDir);
  assert.ok(files.length >= 3, `expected the listing layer to have files, found ${files.length}`);
  const bad: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (const [i, line] of lines.entries()) {
      for (const rule of COLOUR_RULES) {
        rule.re.lastIndex = 0;
        const m = rule.re.exec(line);
        if (m !== null) bad.push(`${relative(root, file)}:${i + 1}: ${rule.name}: ${m[0]}`);
      }
    }
  }
  assert.deepEqual(bad, [], `literal colours in the listing layer:\n${bad.join("\n")}`);
});

test("the colour detector still fires (the rule cannot rot into a no-op)", () => {
  const samples = ["color: #4c9be8;", "background: rgb(1,2,3)", "className=\"bg-slate-900\"", "text-white"];
  for (const s of samples) {
    assert.ok(COLOUR_RULES.some((r) => { r.re.lastIndex = 0; return r.re.test(s); }), `detector missed ${s}`);
  }
});

test("the CodeMirror editor theme goes through EditorView.theme with var() values", () => {
  const theme = readFileSync(join(listingDir, "cm-theme.ts"), "utf8");
  assert.match(theme, /EditorView\.theme\(/, "the editor chrome must be an EditorView.theme");
  assert.match(theme, /HighlightStyle\.define\(/, "syntax must use an explicit HighlightStyle, not CodeMirror's default palette");
  const values = [...theme.matchAll(/(?:color|backgroundColor|borderLeftColor|border|borderRight|outline|caretColor)\s*:\s*"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(values.length > 10, `expected the theme to set many colour properties, saw ${values.length}`);
  const literal = values.filter((v) => !v.includes("var(--") && v !== "none" && v !== "transparent");
  assert.deepEqual(literal, [], `non-token colour values in the editor theme: ${literal.join(", ")}`);
});

// -- 2. selection.ts mirrors ActionContext.selection -------------------------

/** The body of `export interface <name> {...}` in `src`. */
function interfaceBody(src: string, name: string): string {
  const start = src.indexOf(`export interface ${name} {`);
  assert.notEqual(start, -1, `interface ${name} not found`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated interface ${name}`);
}

/** Field names declared in an interface body, ignoring comments. */
function fieldsOf(body: string): string[] {
  return [...body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").matchAll(/(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/g)].map((m) => m[1]!);
}

function unionMembers(src: string, name: string): string[] {
  const m = new RegExp(String.raw`export type ${name}\s*=([^;]+);`).exec(src);
  assert.notEqual(m, null, `type ${name} not found`);
  return [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!).sort();
}

test("selection.ts declares every field ActionContext.selection needs", () => {
  const actions = readFileSync(actionsFile, "utf8");
  const store = readFileSync(selectionFile, "utf8");
  const want = fieldsOf(interfaceBody(actions, "Selection"));
  const got = new Set(fieldsOf(interfaceBody(store, "Selection")));
  assert.ok(want.includes("kind") && want.includes("fn"), `sanity: src/ui-core/actions.ts Selection fields = ${want.join(",")}`);
  const missing = want.filter((f) => !got.has(f));
  assert.deepEqual(missing, [], `ui/src/state/selection.ts is missing ${missing.join(", ")} — actions would get an unusable selection`);
});

test("selection kinds match src/ui-core/actions.ts exactly", () => {
  assert.deepEqual(
    unionMembers(readFileSync(selectionFile, "utf8"), "SelectionKind"),
    unionMembers(readFileSync(actionsFile, "utf8"), "SelectionKind"),
  );
});

test("selection.ts exports the store surface the other panes import", () => {
  const store = readFileSync(selectionFile, "utf8");
  for (const sym of ["select", "useSelection", "getSelection", "back", "forward", "jumpList", "JUMP_LIMIT"]) {
    assert.match(store, new RegExp(String.raw`export (?:function|const) ${sym}\b|export \{[^}]*\b${sym}\b`), `selection.ts must export ${sym}`);
  }
  assert.match(store, /JUMP_LIMIT\s*=\s*100/, "the jump list is capped at 100 entries");
});

// -- 3. the pure listing helpers --------------------------------------------

test("groupModules splits node_modules packages from the app's own modules", async () => {
  const m = await import(pathToFileURL(join(listingDir, "modules.ts")).href);
  assert.equal(m.packageOf("node_modules/lodash/isEqual.js"), "lodash");
  assert.equal(m.packageOf("node_modules/@react-navigation/native/lib/index.js"), "@react-navigation/native");
  assert.equal(m.packageOf("src/auth/licence.js"), null);
  const mod = (id: number, file: string): unknown => ({ id, file, factoryFn: null, deps: [], segment: 0 });
  const groups = m.groupModules([
    mod(0, "node_modules/lodash/isEqual.js"),
    mod(1, "src/index.js"),
    mod(2, "node_modules/lodash/merge.js"),
    mod(3, ""),
  ]) as readonly { key: string; label: string; modules: readonly unknown[] }[];
  assert.deepEqual(groups.map((g) => g.label), ["src/", "node_modules/lodash", "(no path)"]);
  assert.equal(groups[1]!.modules.length, 2, "both lodash modules land in one group");
});

test("the listing caps rendered lines and reports how many it hid", async () => {
  const t = await import(pathToFileURL(join(listingDir, "truncate.ts")).href);
  assert.equal(t.MAX_RENDER_LINES, 5000);
  const short = t.clampLines("a\nb\nc", 3, false);
  assert.equal(short.truncated, false);
  assert.equal(short.hidden, null);
  const long = t.clampLines(Array.from({ length: 12000 }, (_u, i) => `line ${i}`).join("\n"), 12000, false);
  assert.equal(long.shown, 5000);
  assert.equal(long.truncated, true);
  assert.equal(long.hidden, 7000);
  assert.equal(long.text.split("\n").length, 5000);
  // The server's own truncation must survive even when we render everything.
  const serverCut = t.clampLines("a\nb", 900, true);
  assert.equal(serverCut.truncated, true);
  assert.equal(serverCut.hidden, 898);
});

test("the CodeMirror dependencies are exact pins", () => {
  const pkg = JSON.parse(readFileSync(join(root, "ui", "package.json"), "utf8")) as { dependencies: Record<string, string> };
  const cm = Object.entries(pkg.dependencies).filter(([n]) => n.startsWith("@codemirror/") || n.startsWith("@lezer/") || n === "@replit/codemirror-vim");
  assert.ok(cm.length >= 6, `expected the CodeMirror stack in ui/package.json, saw ${cm.map(([n]) => n).join(",")}`);
  for (const [name, range] of cm) assert.match(range, /^\d+\.\d+\.\d+$/, `${name} must be an exact pin, got ${range}`);
});

// -- 4. the screens-first tree (GET /api/segregation) ------------------------
// A production Metro bundle has no module paths: `ModuleEntry.file` is
// `module_<id>.js` for all 4,510 of Service NSW's modules, so `groupModules`
// above yields ONE group with everything in it. `groupModulesSegregated`
// groups by the recovered paths from `/api/segregation` instead. These assert
// this helper's own properties (order, membership, labels, fallback) — no
// literal comparison against any shared fixture's output.

const segMod = (id: number): unknown => ({ id, file: `module_${id}.js`, factoryFn: null, deps: [], segment: 0 });

function segPage(rows: readonly [number, string, string, string | null][]): unknown {
  return {
    modules: rows.map(([id, path, bucket, pkg]) => ({ id, path, bucket, package: pkg, nameSignal: null, nameConfidence: null })),
    counts: { screens: 0, navigation: 0, src: 0, node_modules: 0, unclassified: 0 },
  };
}

const SEG_FIXTURE = segPage([
  [1, "src/screens/HomeScreen.js", "src", null],
  [2, "_unclassified/module_2.js", "unclassified", null],
  [3, "node_modules/lodash/module_3.js", "node_modules", "lodash"],
  [4, "src/navigation/RootNavigator.js", "src", null],
  [5, "src/store/counterSlice.js", "src", null],
  [6, "node_modules/@react-navigation/native/module_6.js", "node_modules", "@react-navigation/native"],
  [7, "src/screens/AboutScreen.js", "src", null],
]);
const SEG_IDS = [1, 2, 3, 4, 5, 6, 7];

test("groupModulesSegregated orders Screens, Navigation, App, packages, Unclassified last", async () => {
  const m = await import(pathToFileURL(join(listingDir, "modules.ts")).href);
  const groups = m.groupModulesSegregated(SEG_IDS.map(segMod), SEG_FIXTURE) as readonly { key: string; label: string; kind: string; modules: { id: number }[]; defaultOpen?: boolean }[];
  assert.deepEqual(groups.map((g) => g.label), [
    "Screens", "Navigation", "App", "node_modules/@react-navigation/native", "node_modules/lodash", "Unclassified",
  ]);
  assert.equal(groups.at(-1)!.kind, "unclassified", "Unclassified is always last — it is 4,316 of NSW's 4,510 modules");
  assert.deepEqual(groups[0]!.modules.map((x) => x.id), [7, 1], "screens sort by their recovered basename (AboutScreen before HomeScreen)");
  assert.deepEqual(groups[1]!.modules.map((x) => x.id), [4]);
  assert.deepEqual(groups[2]!.modules.map((x) => x.id), [5]);
  assert.deepEqual(groups[5]!.modules.map((x) => x.id), [2]);
});

test("groupModulesSegregated opens Screens and Navigation and nothing else", async () => {
  const m = await import(pathToFileURL(join(listingDir, "modules.ts")).href);
  const groups = m.groupModulesSegregated(SEG_IDS.map(segMod), SEG_FIXTURE) as readonly { label: string }[];
  assert.deepEqual(m.defaultOpenGroups(groups), [m.SCREENS_KEY, m.NAVIGATION_KEY]);
});

test("a module label is the basename of its recovered path, and every module keeps a group", async () => {
  const m = await import(pathToFileURL(join(listingDir, "modules.ts")).href);
  const byId = m.segregationById(SEG_FIXTURE) as Map<number, unknown>;
  assert.equal(m.basenameOf("src/screens/HomeScreen.js"), "HomeScreen.js");
  assert.equal(m.basenameOf("index.js"), "index.js");
  assert.equal(m.moduleLabelSegregated(segMod(1), byId.get(1)), "HomeScreen.js");
  // No segregation row for this id -> falls back to the flat label, and the
  // module still appears (in Unclassified) rather than vanishing.
  assert.equal(m.moduleLabelSegregated(segMod(99), undefined), "module_99.js");
  const groups = m.groupModulesSegregated([...SEG_IDS, 99].map(segMod), SEG_FIXTURE) as readonly { label: string; modules: { id: number }[] }[];
  const placed = groups.flatMap((g) => g.modules.map((x) => x.id)).sort((a, b) => a - b);
  assert.deepEqual(placed, [...SEG_IDS, 99]);
  assert.deepEqual(groups.at(-1)!.modules.map((x) => x.id), [2, 99]);
});

test("groupModulesSegregated falls back to groupModules when segregation is unavailable", async () => {
  const m = await import(pathToFileURL(join(listingDir, "modules.ts")).href);
  const rows = [
    { id: 0, file: "node_modules/lodash/isEqual.js", factoryFn: null, deps: [], segment: 0 },
    { id: 1, file: "src/index.js", factoryFn: null, deps: [], segment: 0 },
  ];
  assert.deepEqual(m.groupModulesSegregated(rows, null), m.groupModules(rows), "no segregation must never mean a blank tree");
});

test("filterGroups filters on group labels and module labels, keeping the tree shape", async () => {
  const m = await import(pathToFileURL(join(listingDir, "modules.ts")).href);
  const groups = m.groupModulesSegregated(SEG_IDS.map(segMod), SEG_FIXTURE) as readonly { label: string; modules: { id: number }[] }[];
  const byId = m.segregationById(SEG_FIXTURE) as Map<number, unknown>;
  const labelOf = (x: { id: number }): string => m.moduleLabelSegregated(x, byId.get(x.id)) as string;
  assert.equal(m.filterGroups(groups, "  ", labelOf), groups, "a blank query filters nothing");
  const home = m.filterGroups(groups, "home", labelOf) as readonly { label: string; modules: { id: number }[] }[];
  assert.deepEqual(home.map((g) => g.label), ["Screens"]);
  assert.deepEqual(home[0]!.modules.map((x) => x.id), [1]);
  const byGroup = m.filterGroups(groups, "lodash", labelOf) as readonly { label: string; modules: { id: number }[] }[];
  assert.deepEqual(byGroup.map((g) => g.label), ["node_modules/lodash"]);
  assert.equal(byGroup[0]!.modules.length, 1, "a group whose own label matches keeps all of its modules");
});

test("the LeftPane tree groups by segregation, not by ModuleEntry.file", () => {
  const pane = readFileSync(join(root, "ui", "src", "panes", "LeftPane.tsx"), "utf8");
  assert.match(pane, /groupModulesSegregated\(/, "the tree must group by /api/segregation");
  assert.doesNotMatch(pane, /\bgroupModules\(/, "grouping by ModuleEntry.file puts all 4,510 NSW modules in one group");
  assert.match(pane, /useSegregation\(\)/, "LeftPane reads /api/segregation through its own query hook");
  assert.match(pane, /filterGroups\(/, "the search box must filter the tree, not just the fn hit list");
});

// -- 5. the jump list behind the back/forward arrows -------------------------
// `ui/src/state/selection.ts` imports `useSyncExternalStore` from react, and
// the gate runs with no ui/node_modules — so the store is imported as a copy
// with that one import stubbed. Everything under test (`select`, `back`,
// `forward`, `canBack`, `canForward`) is plain module state; the React
// binding is not exercised and is not what these assert.

async function importSelectionStore(): Promise<{ readonly mod: Record<string, Function>; readonly dir: string }> {
  const src = readFileSync(selectionFile, "utf8").replace(
    /^import \{ useSyncExternalStore \} from "react";$/m,
    "const useSyncExternalStore = (_s: unknown, get: () => unknown): unknown => get();",
  );
  assert.doesNotMatch(src, /from "react"/, "the react stub must have replaced the only react import");
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-selection-"));
  const file = join(dir, "selection.ts");
  writeFileSync(file, src);
  return { mod: (await import(pathToFileURL(file).href)) as Record<string, Function>, dir };
}

test("canBack/canForward drive the TopBar arrows: two selects, then back", async () => {
  const { mod: s, dir } = await importSelectionStore();
  try {
    s.resetSelection!();
    assert.equal(s.canBack!(), false, "nothing visited yet: Back is disabled");
    assert.equal(s.canForward!(), false);

    s.select!({ kind: "fn", fn: 10 });
    s.select!({ kind: "fn", fn: 20 });
    assert.equal(s.canBack!(), true);
    assert.equal(s.canForward!(), false, "at the head of the jump list there is nowhere forward");

    assert.deepEqual(s.back!(), { kind: "fn", fn: 10 });
    assert.equal(s.canBack!(), true, "the initial no-selection entry is still behind us");
    assert.equal(s.canForward!(), true, "back() is what enables Forward");

    assert.deepEqual(s.forward!(), { kind: "fn", fn: 20 });
    assert.equal(s.canForward!(), false);

    // A re-select of the current selection is not a jump; a new one truncates
    // the forward history, which is what makes Forward go dead again.
    s.select!({ kind: "fn", fn: 20 });
    assert.equal((s.jumpList!() as { entries: unknown[] }).entries.length, 3);
    s.back!();
    s.select!({ kind: "fn", fn: 30 });
    assert.equal(s.canForward!(), false, "selecting after back() drops the forward branch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
