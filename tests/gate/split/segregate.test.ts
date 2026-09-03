// tests/gate/split/segregate.test.ts — docs/specs/08-segregation.md §6
// milestone 1 acceptance: `hbc2js segregate` moves a `--split` tree's
// modules into `node_modules/<pkg>/` (library) vs `src/` (custom) vs
// `_unclassified/` (no classify.ts verdict) without changing any factory
// body, and the segregated tree still boots exactly as far as the
// un-segregated one (§4, resolver-equivalence proof).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { cachedSplitProject as splitProject } from "../../support/decompiled.ts";
import { readSplitDir, segregateSplitTree, writeSegregateResult } from "../../../src/split/segregate.ts";
import { runDeps } from "../../../src/deps/index.ts";
import type { DepsReport } from "../../../src/deps/report.ts";
import { writeSplitResult } from "../../../src/split/write.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

// The un-segregated boot test (tests/gate/split/loadable.test.ts) pins 76 as
// its floor on this exact fixture; segregation must not make the resolver
// re-run reach any fewer modules (§4.2 — no require() edge segregation
// rewrote should stop resolving).
const MIN_MODULES_RUN = 76;

/** Strips only what segregation is allowed to change (§4): a
 *  `require('./module_<id>.js')` call's string-literal argument, and (§6
 *  milestone 2) a renamed module's prepended `// hbc2js segregate --`
 *  header line. Everything else in a module file — including the original
 *  `// hbc2js --split --` header — must come out byte-identical. */
// Milestone 3 note: a segregation rewrite's require() target string can now
// name a *renamed* module (e.g. `./screens/TouchEventTypeScreen.js`, not
// `./module_478.js` — observed on react-navigation-example-0.85.3's own
// module 5, which requires a module milestone 3 renamed), so this can no
// longer normalise by recovering the numeric module id from a
// `module_<N>.js`-shaped target (milestone 1/2's tests never exercised a
// require() *target* that got renamed, only the modules being renamed
// themselves) — it normalises away the whole require() argument instead,
// on both sides, which is still exactly what §4 says segregation is
// allowed to touch (a require() call's string-literal argument).
function normaliseRequireTargets(text: string): string {
  const withoutSegregateHeader = text.startsWith("// hbc2js segregate -- ") ? text.slice(text.indexOf("\n") + 1) : text;
  return withoutSegregateHeader.replace(/require\((['"])(?:(?!\1).)*\1\)/g, "require(<target>)");
}

void test("segregate: moves rn-template-0.72's split tree into node_modules/ vs src/, no factory body changes, boot still reaches registerComponent", async () => {
  const bytes = readFileSync(RN_TEMPLATE);
  const split = splitProject(bytes, { moduleName: "index.android.hbc" });
  assert.ok(split.modules.length > 0, "split produced no modules");

  const depsRun = await runDeps(RN_TEMPLATE, { offline: true });
  assert.ok(depsRun.report.classification !== null, "deps run produced no classification");

  const seg = segregateSplitTree(split.files, depsRun.report);

  // (c) no module is lost: count in == count out, and every module landed
  // in exactly one of the three buckets.
  assert.equal(seg.modules.length, split.modules.length, "segregation dropped or duplicated a module");
  const seenIds = new Set(seg.modules.map((m) => m.id));
  assert.equal(seenIds.size, split.modules.length, "segregation produced duplicate module ids");
  for (const m of seg.modules) assert.ok(m.bucket === "src" || m.bucket === "node_modules" || m.bucket === "unclassified", `module ${m.id} landed in an unknown bucket ${m.bucket}`);

  // Milestone 1: some modules of each headline kind, on this fixture
  // (DEPS.md's seed-run numbers: ~41% library by weight).
  const srcCount = seg.modules.filter((m) => m.bucket === "src").length;
  const nodeModulesCount = seg.modules.filter((m) => m.bucket === "node_modules").length;
  assert.ok(srcCount > 0, "expected at least one custom module in src/");
  assert.ok(nodeModulesCount > 0, "expected at least one library module in node_modules/");

  // Milestone 2 (§2.1 steps 1-5): rn-template-0.72's module 0 is both the
  // split tree's entry (MODULES.json.entry === 0) and the module that calls
  // `AppRegistry.registerComponent(...)` directly -- accept either name this
  // spec-documented collision could produce (see segregate.ts
  // `nameCandidateFor`'s header comment for which one this implementation
  // picks and why), but require it be *one* of the two, not the untouched
  // `module_0.js` fallback.
  const entryModule = seg.modules.find((m) => m.id === 0)!;
  assert.ok(entryModule.newPath === "src/index.js" || entryModule.newPath === "src/App.js", `entry module (id 0) should name to src/index.js or src/App.js, got ${entryModule.newPath}`);
  // Whichever way the collision above resolves, *some* module must end up
  // named src/App.js -- the registerComponent-bearing module (here, the
  // same module 0) is never left as a numeric fallback name.
  assert.ok(seg.modules.some((m) => m.newPath === "src/App.js"), "no module named src/App.js (registerComponent signal not resolved)");
  assert.equal(entryModule.nameSignal !== null, true, "entry module has no recorded naming signal");

  // No two modules collide on the same final path.
  const pathCounts = new Map<string, number>();
  for (const m of seg.modules) pathCounts.set(m.newPath, (pathCounts.get(m.newPath) ?? 0) + 1);
  for (const [path, count] of pathCounts) assert.equal(count, 1, `${count} modules collided on ${path}`);

  // (b) structural proof: every module's file, modulo require() target
  // strings, is byte-identical before and after segregation.
  for (const m of split.modules) {
    const before = split.files.get(m.file);
    const after = seg.files.get(seg.modules.find((s) => s.id === m.id)!.newPath);
    assert.ok(before !== undefined && after !== undefined, `module ${m.id} missing before/after text`);
    assert.equal(normaliseRequireTargets(after!), normaliseRequireTargets(before!), `module ${m.id}'s factory body changed during segregation`);
  }

  // (a) behavioural proof: reuse tools/e2e/boot-split.mjs, pointed at the
  // segregated tree on disk (its only input is a directory + index.js).
  const splitDir = mkdtempSync(join(tmpdir(), "hbc2js-segregate-split-"));
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-segregate-out-"));
  try {
    writeSplitResult(split, splitDir);
    const reread = segregateSplitTree(readSplitDir(splitDir), depsRun.report);
    writeSegregateResult(reread, outDir);

    const r = spawnSync(process.execPath, [join(repoRoot(), "tools", "e2e", "boot-split.mjs"), outDir, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `boot-split.mjs exited ${r.status}: ${r.stderr}`);
    const result = JSON.parse(r.stdout) as { modulesExecuted: number; reachedRegisterComponent: boolean; componentName: string | null; firstThrow: unknown };
    assert.ok(result.modulesExecuted >= MIN_MODULES_RUN, `only ${result.modulesExecuted} module(s) ran on the segregated tree (floor ${MIN_MODULES_RUN})`);
    assert.equal(result.reachedRegisterComponent, true, `segregated tree did not reach AppRegistry.registerComponent (first throw: ${JSON.stringify(result.firstThrow)})`);
    assert.equal(result.componentName, "HelloHermes072");
  } finally {
    rmSync(splitDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

/** rn-template-0.72 ships no screens/store (docs/specs/08-segregation.md §5:
 *  "the template ships no screens/store"), so §2.1 steps 3-5 (displayName,
 *  default-export identifier, createSlice) and collision suffixing are
 *  exercised here against a hand-built split tree instead of a fetched
 *  fixture, matching this milestone's single-module, no-hermesc-needed
 *  scope. `deps` is `null` here (no classify.ts run), so every custom
 *  module is fed to naming directly via a fabricated `DepsReport`-shaped
 *  classification -- `segregateSplitTree` never re-derives classification
 *  itself, so a minimal stand-in is enough. */
void test("segregate: names displayName/default-export/createSlice modules and suffixes name collisions deterministically by id", () => {
  const modulesJson = {
    hbcVersion: 96,
    moduleCount: 5,
    entry: null,
    modules: [
      { id: 1, file: "module_1.js", factoryFunctionIndex: 1, deps: [] },
      { id: 2, file: "module_2.js", factoryFunctionIndex: 2, deps: [] },
      { id: 3, file: "module_3.js", factoryFunctionIndex: 3, deps: [] },
      { id: 5, file: "module_5.js", factoryFunctionIndex: 5, deps: [] },
      { id: 9, file: "module_9.js", factoryFunctionIndex: 9, deps: [] },
    ],
  };
  const files = new Map<string, string>([
    ["MODULES.json", JSON.stringify(modulesJson)],
    ["index.js", `require('./module_1.js');\nrequire('./module_2.js');\nrequire('./module_3.js');\nrequire('./module_5.js');\nrequire('./module_9.js');\nvar __hbc_split_Module = require("module");\nvar __hbc_split_origLoad = __hbc_split_Module._load;\n__hbc_split_Module._load = function (request, parent, isMain) {\n  var m = /^\\.\\/module_(\\d+)\\.js$/.exec(request);\n  if (m) return __r(Number(m[1]));\n  return __hbc_split_origLoad.apply(this, arguments);\n};\n`],
    // Step 3: displayName assignment.
    ["module_1.js", `// hbc2js --split -- Metro module 1 (source fn#1, x)\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n  r0.displayName = "Greeting";\n}\n\n__d(factory, 1, []);\n`],
    // Step 4: default-export identifier (function Foo() {...}; module.exports = Foo;).
    ["module_2.js", `// hbc2js --split -- Metro module 2 (source fn#2, x)\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n  function Widget(a) { return a; }\n  r0 = a5;\n  r0.exports = Widget;\n}\n\n__d(factory, 2, []);\n`],
    // Step 5: createSlice.
    ["module_3.js", `// hbc2js --split -- Metro module 3 (source fn#3, x)\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n  r0 = createSlice({name: "counter", initialState: 0});\n}\n\n__d(factory, 3, []);\n`],
    // Two more modules that both resolve to displayName "Greeting" -- collision.
    ["module_5.js", `// hbc2js --split -- Metro module 5 (source fn#5, x)\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n  r0.displayName = "Greeting";\n}\n\n__d(factory, 5, []);\n`],
    ["module_9.js", `// hbc2js --split -- Metro module 9 (source fn#9, x)\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n  r0.displayName = "Greeting";\n}\n\n__d(factory, 9, []);\n`],
  ]);
  const deps = {
    matches: [],
    guesses: [],
    confirmed: [],
    moduleOwnership: [],
    classification: {
      modules: [1, 2, 3, 5, 9].map((id) => ({ localModuleId: id, factoryFunctionIndex: id, instrCount: 1, classification: "custom", signal: "app-vocabulary", confidence: 0.9, libraryPackageHint: null })),
    },
  } as unknown as DepsReport;

  const seg = segregateSplitTree(files, deps);
  const byId = new Map(seg.modules.map((m) => [m.id, m]));
  assert.equal(byId.get(1)!.newPath, "src/Greeting.js");
  assert.equal(byId.get(2)!.newPath, "src/Widget.js");
  assert.equal(byId.get(3)!.newPath, "src/store/counterSlice.js");
  // Collision: modules 1, 5, 9 all resolve to "Greeting" -- id-ordered
  // suffixing (spec §2.1 "Collisions"), lowest id keeps the bare name.
  assert.equal(byId.get(5)!.newPath, "src/Greeting.2.js");
  assert.equal(byId.get(9)!.newPath, "src/Greeting.3.js");

  const pathCounts = new Map<string, number>();
  for (const m of seg.modules) pathCounts.set(m.newPath, (pathCounts.get(m.newPath) ?? 0) + 1);
  for (const [path, count] of pathCounts) assert.equal(count, 1, `${count} modules collided on ${path}`);
});

/** Milestone 3 (docs/specs/08-segregation.md §6 milestone 3, §3.1/§3.2):
 *  a hand-built split tree exercising the two new cross-module signals on
 *  the exact statement shapes observed on react-navigation-example-0.85.3
 *  (fixed 7-param `factory(a1..a7)` signature; `require`/`dependencyMap`
 *  accessed positionally as `a2`/`a7`; a route registry as a `{RouteName:
 *  null, ...}` object literal whose keys get overwritten one by one with a
 *  required module's value) -- deterministic and fast, independent of the
 *  real fixture so a future decompiler change can't silently break this
 *  rung's own signal-detection logic without a fixture rebuild.
 */
void test("segregate: detects a navigator (create<X>Navigator + @react-navigation dep) and a route registry's screen targets", () => {
  const modulesJson = {
    hbcVersion: 98,
    moduleCount: 4,
    entry: null,
    modules: [
      { id: 11, file: "module_11.js", factoryFunctionIndex: 11, deps: [] }, // @react-navigation/stack (library)
      { id: 12, file: "module_12.js", factoryFunctionIndex: 12, deps: [11, 20, 21] }, // navigator module
      { id: 20, file: "module_20.js", factoryFunctionIndex: 20, deps: [] }, // Home screen component
      { id: 21, file: "module_21.js", factoryFunctionIndex: 21, deps: [] }, // Profile screen component
    ],
  };
  const files = new Map<string, string>([
    ["MODULES.json", JSON.stringify(modulesJson)],
    [
      "index.js",
      `require('./module_11.js');\nrequire('./module_12.js');\nrequire('./module_20.js');\nrequire('./module_21.js');\nvar __hbc_split_Module = require("module");\nvar __hbc_split_origLoad = __hbc_split_Module._load;\n__hbc_split_Module._load = function (request, parent, isMain) {\n  var m = /^\\.\\/module_(\\d+)\\.js$/.exec(request);\n  if (m) return __r(Number(m[1]));\n  return __hbc_split_origLoad.apply(this, arguments);\n};\n`,
    ],
    ["module_11.js", `// hbc2js --split -- Metro module 11\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 11, []);\n`],
    // Navigator module (§3.1): calls a create<X>Navigator-shaped property,
    // and depends directly on module 11 (owned by @react-navigation/stack).
    [
      "module_12.js",
      `// hbc2js --split -- Metro module 12\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n  let r0, r1, r2, r3, r4, r5;\n  r2 = a2;\n  r1 = a7;\n  r0 = require('./module_11.js');\n  r5 = r0.createStackNavigator;\n  r4 = r1[1];\n  r3 = r2(r4);\n  r0 = {Home: null, Profile: null};\n  r0.Home = r3;\n  r4 = r1[2];\n  r3 = r2(r4);\n  r0.Profile = r3;\n}\n\n__d(factory, 12, [11, 20, 21]);\n`,
    ],
    ["module_20.js", `// hbc2js --split -- Metro module 20\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 20, []);\n`],
    ["module_21.js", `// hbc2js --split -- Metro module 21\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 21, []);\n`],
  ]);
  const deps = {
    matches: [],
    guesses: [],
    confirmed: [],
    moduleOwnership: [{ localModuleId: 11, factoryFunctionIndex: 11, package: "@react-navigation/stack", version: "7.0.0" }],
    classification: {
      modules: [
        { localModuleId: 11, factoryFunctionIndex: 11, instrCount: 1, classification: "library", signal: "package-name-version-string", confidence: 0.95, libraryPackageHint: "@react-navigation/stack" },
        { localModuleId: 12, factoryFunctionIndex: 12, instrCount: 1, classification: "custom", signal: "app-vocabulary", confidence: 0.9, libraryPackageHint: null },
        { localModuleId: 20, factoryFunctionIndex: 20, instrCount: 1, classification: "custom", signal: "app-vocabulary", confidence: 0.9, libraryPackageHint: null },
        { localModuleId: 21, factoryFunctionIndex: 21, instrCount: 1, classification: "custom", signal: "app-vocabulary", confidence: 0.9, libraryPackageHint: null },
      ],
    },
  } as unknown as DepsReport;

  const seg = segregateSplitTree(files, deps);
  const byId = new Map(seg.modules.map((m) => [m.id, m]));

  // §3.1: module 12 calls `.createStackNavigator` and directly depends on
  // module 11, owned by @react-navigation/stack -- named into
  // src/navigation/, confidence 0.9 (spec's "named" tier).
  assert.equal(byId.get(12)!.newPath, "src/navigation/StackNavigator.js");
  assert.equal(byId.get(12)!.nameConfidence, 0.9);

  // §3.2: module 12's `{Home: null, Profile: null}` route registry
  // resolves Home -> module 20, Profile -> module 21 via the dependencyMap-
  // index trace (`a7[1]`/`a7[2]` -> deps[1]/deps[2] -> require(a2, ...)).
  assert.equal(byId.get(20)!.newPath, "src/screens/HomeScreen.js");
  assert.equal(byId.get(21)!.newPath, "src/screens/ProfileScreen.js");
  assert.equal(byId.get(20)!.nameConfidence, 0.85);
  assert.equal(byId.get(20)!.nameSignal, 'screen-route (route "Home", §3.2)');

  // 2026-09-02 (Service NSW brief): the SAME split tree, with NO deps report
  // at all (`deps === null`, module 11/12/20/21 all start "unclassified") --
  // navigator/screen detection must still fire from call/config shape alone.
  // Module 11 (the react-navigation dep itself) has no name signal of its
  // own and correctly stays `_unclassified/`; 12/20/21 get promoted to
  // `src/` by their own navigator/screen-route name candidates.
  const segNoDeps = segregateSplitTree(files, null);
  const byIdNoDeps = new Map(segNoDeps.modules.map((m) => [m.id, m]));
  assert.equal(byIdNoDeps.get(12)!.bucket, "src");
  assert.equal(byIdNoDeps.get(12)!.newPath, "src/navigation/StackNavigator.js");
  assert.equal(byIdNoDeps.get(12)!.nameConfidence, 0.6); // shape alone, no deps confirmation -- below the 0.9 "named" tier above
  assert.equal(byIdNoDeps.get(20)!.bucket, "src");
  assert.equal(byIdNoDeps.get(20)!.newPath, "src/screens/HomeScreen.js");
  assert.equal(byIdNoDeps.get(20)!.nameConfidence, 0.85); // §3.2's literal-route tier doesn't depend on classification at all
  assert.equal(byIdNoDeps.get(21)!.newPath, "src/screens/ProfileScreen.js");
  assert.equal(byIdNoDeps.get(11)!.bucket, "unclassified"); // no name signal of its own -- correctly not guessed into src/ or node_modules/
});

// 2026-09-02 (generalization-sweep brief, docs/BUGS.md "screen-naming
// over-fit" row): a NON-navigator module with a PascalCase-keyed data
// registry -- shape-identical to a `createXNavigator({ RouteName: Component
// })` route config (§3.2), but with no `create<X>Navigator` call, no
// `routeConfig`/`*NavigationRoutes` naming convention, and no consumer that
// has either -- must produce ZERO screens. Modelled directly on the real
// false positive found on Brex (proprietary, not committed): a css-tree
// AST node-type registry, `{AtrulePrelude: null, AttributeSelector: null,
// ...}` later filled `.AtrulePrelude = require('./AtrulePrelude.js');`, one
// required module per node type -- exactly `traceModuleOrigins`'s
// `routeObjRegs` shape, just never wired to a navigator anywhere.
void test("segregate: a non-navigator PascalCase-keyed data registry (css-tree node-type-registry shape) produces zero screens", () => {
  const modulesJson = {
    hbcVersion: 98,
    moduleCount: 3,
    entry: null,
    modules: [
      { id: 40, file: "module_40.js", factoryFunctionIndex: 40, deps: [50, 51] }, // node-type registry, no navigator in sight
      { id: 50, file: "module_50.js", factoryFunctionIndex: 50, deps: [] }, // AtrulePrelude "node type" module
      { id: 51, file: "module_51.js", factoryFunctionIndex: 51, deps: [] }, // AttributeSelector "node type" module
    ],
  };
  const files = new Map<string, string>([
    ["MODULES.json", JSON.stringify(modulesJson)],
    [
      "index.js",
      `require('./module_40.js');\nrequire('./module_50.js');\nrequire('./module_51.js');\nvar __hbc_split_Module = require("module");\nvar __hbc_split_origLoad = __hbc_split_Module._load;\n__hbc_split_Module._load = function (request, parent, isMain) {\n  var m = /^\\.\\/module_(\\d+)\\.js$/.exec(request);\n  if (m) return __r(Number(m[1]));\n  return __hbc_split_origLoad.apply(this, arguments);\n};\n`,
    ],
    // No `create<X>Navigator`/`createStaticNavigation` call, no
    // `routeConfig`/`*NavigationRoutes` self-export -- just a plain
    // PascalCase-keyed registry object, same shape §3.2's route registry
    // uses, filled from two required modules.
    [
      "module_40.js",
      `// hbc2js --split -- Metro module 40\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n  let r0, r1, r2, r3, r4;\n  r2 = a2;\n  r1 = a7;\n  r0 = {AtrulePrelude: null, AttributeSelector: null};\n  r4 = r1[0];\n  r3 = r2(r4);\n  r0.AtrulePrelude = r3;\n  r4 = r1[1];\n  r3 = r2(r4);\n  r0.AttributeSelector = r3;\n}\n\n__d(factory, 40, [50, 51]);\n`,
    ],
    ["module_50.js", `// hbc2js --split -- Metro module 50\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 50, []);\n`],
    ["module_51.js", `// hbc2js --split -- Metro module 51\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 51, []);\n`],
  ]);

  const seg = segregateSplitTree(files, null); // no deps report -- shape alone, same as the real Brex/Uniswap runs this fixture models
  const byId = new Map(seg.modules.map((m) => [m.id, m]));
  assert.equal(byId.get(50)!.nameSignal, null, "module 50 must not be named a screen -- module 40 has no navigator connection");
  assert.equal(byId.get(51)!.nameSignal, null, "module 51 must not be named a screen -- module 40 has no navigator connection");
  assert.notEqual(byId.get(50)!.newPath, "src/screens/AtrulePreludeScreen.js"); // the exact false positive observed on Brex
  assert.notEqual(byId.get(51)!.newPath, "src/screens/AttributeSelectorScreen.js");
  const screens = seg.modules.filter((m) => m.nameSignal?.startsWith("screen-route"));
  assert.equal(screens.length, 0, "no navigator anywhere in this split tree -- zero screens, not garbage");
});

// 2026-09-02 (navigator-detection tightening brief, following the NSW
// route-resolution report's "bare createXNavigator re-exports mis-detected
// as navigators" note): a module whose entire job is to require a
// navigator factory, call/read it, and export the result straight through
// -- no `{name, component}` registry of its own, no `Object.entries(...)`
// consumer walk -- is not a navigator. Module 13's shape is exactly the one
// hand-confirmed on Service NSW (BUGS.md row, fifth revisit): a single flat
// factory function, `.createStackNavigator` read off the required package,
// called with a route config it never builds itself (`r1[2]`, a *separate*
// required module, module 15 -- the "externally-sourced" half of "no route
// config of its own"), and the call result exported straight through.
void test("segregate: a bare create<X>Navigator re-export (require + call/read + export, no owned or consumed route config) is not counted as a navigator", () => {
  const modulesJson = {
    hbcVersion: 98,
    moduleCount: 3,
    entry: null,
    modules: [
      { id: 11, file: "module_11.js", factoryFunctionIndex: 11, deps: [] }, // @react-navigation/stack (library)
      { id: 13, file: "module_13.js", factoryFunctionIndex: 13, deps: [11, 15] }, // bare re-export, no registry of its own
      { id: 15, file: "module_15.js", factoryFunctionIndex: 15, deps: [] }, // externally-sourced route config
    ],
  };
  const files = new Map<string, string>([
    ["MODULES.json", JSON.stringify(modulesJson)],
    [
      "index.js",
      `require('./module_11.js');\nrequire('./module_13.js');\nrequire('./module_15.js');\nvar __hbc_split_Module = require("module");\nvar __hbc_split_origLoad = __hbc_split_Module._load;\n__hbc_split_Module._load = function (request, parent, isMain) {\n  var m = /^\\.\\/module_(\\d+)\\.js$/.exec(request);\n  if (m) return __r(Number(m[1]));\n  return __hbc_split_origLoad.apply(this, arguments);\n};\n`,
    ],
    ["module_11.js", `// hbc2js --split -- Metro module 11\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 11, []);\n`],
    // Bare re-export (§3.1 tightening): reads `.createStackNavigator` off
    // the required package, calls it with module 15's already-built config
    // (no `{name: ...}`/`.name =`/`.component =` registry pattern anywhere
    // in THIS module's own text), and exports the call result directly.
    [
      "module_13.js",
      `// hbc2js --split -- Metro module 13\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n  let r0, r1, r2, r3, r4, r5, r6;\n  r2 = a2;\n  r1 = a7;\n  r0 = require('./module_11.js');\n  r5 = r0.createStackNavigator;\n  r4 = r1[1];\n  r3 = r2(r4).routeConfig;\n  r6 = r5(r3);\n  a3.exports = r6;\n}\n\n__d(factory, 13, [11, 15]);\n`,
    ],
    ["module_15.js", `// hbc2js --split -- Metro module 15\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n  let r0;\n  r0 = {};\n  a3.exports.routeConfig = r0;\n}\n\n__d(factory, 15, []);\n`],
  ]);
  const deps = {
    matches: [],
    guesses: [],
    confirmed: [],
    moduleOwnership: [{ localModuleId: 11, factoryFunctionIndex: 11, package: "@react-navigation/stack", version: "7.0.0" }],
    classification: {
      modules: [
        { localModuleId: 11, factoryFunctionIndex: 11, instrCount: 1, classification: "library", signal: "package-name-version-string", confidence: 0.95, libraryPackageHint: "@react-navigation/stack" },
        { localModuleId: 13, factoryFunctionIndex: 13, instrCount: 1, classification: "custom", signal: "app-vocabulary", confidence: 0.9, libraryPackageHint: null },
        { localModuleId: 15, factoryFunctionIndex: 15, instrCount: 1, classification: "custom", signal: "app-vocabulary", confidence: 0.9, libraryPackageHint: null },
      ],
    },
  } as unknown as DepsReport;

  const seg = segregateSplitTree(files, deps);
  const byId = new Map(seg.modules.map((m) => [m.id, m]));
  // Module 13's call-shape alone (`.createStackNavigator`) used to be
  // enough to name it a navigator; it no longer owns or consumes a route
  // config of its own, so it must fall through to a lower-priority signal
  // (or none) rather than `src/navigation/...Navigator.js`.
  assert.ok(!byId.get(13)!.nameSignal?.startsWith("navigator"), `module 13 (bare re-export) should not be name-signalled as a navigator, got ${byId.get(13)!.nameSignal}`);
  assert.doesNotMatch(byId.get(13)!.newPath ?? "", /^src\/navigation\//, "bare re-export should not be filed under src/navigation/");

  // Same result with no deps report (shape-alone path).
  const segNoDeps = segregateSplitTree(files, null);
  const byIdNoDeps = new Map(segNoDeps.modules.map((m) => [m.id, m]));
  assert.ok(!byIdNoDeps.get(13)!.nameSignal?.startsWith("navigator"), `module 13 (bare re-export, no deps report) should not be name-signalled as a navigator, got ${byIdNoDeps.get(13)!.nameSignal}`);
});

// 2026-09-02 (Service NSW brief, BUGS row "segregation-without-deps... 0
// screens"): hand-inspection of Service NSW's own decompiled text (never
// committed, per repo policy) found the JSX-props `.name =`/`.component =`
// shape's *actual* blocking gap on that bundle is not the Reflect.apply hop
// the row's root-cause guess names -- across every real `.component =`
// assignment found there, none go through `Reflect.apply`. Two other gaps
// do block real hits, both fixed here, narrowly: (1) `<props>.component =
// require(<dep>).<NamedExport>;` compiled as a *single* statement (no
// intermediate register for the require call's result before the member
// access -- `callTarget`/`propTarget` each only matched half of this), and
// (2) the interop-default hop spelled with bracket notation
// (`<reg>["default"]`) rather than `.default` (already handled). Both
// gated exactly as narrowly as the existing two-statement case: (1) fires
// only inside a `scanJsxScreenProps`-gated module, only for the literal key
// `component` (not any property), and only when the call resolves through
// `paramAlias`'s `require` tracking, same guard `callTarget` already uses;
// (2) only *forwards* an origin a register already has, so it can't
// introduce a new false-positive resolution, only recognise an existing one
// spelled differently.
void test("segregate: resolves a screen's .component through a single-statement require(dep).NamedExport and a bracket-notation [\"default\"] interop hop", () => {
  const files = new Map<string, string>([
    ["MODULES.json", JSON.stringify({ hbcVersion: 98, moduleCount: 4, entry: null, modules: [
      { id: 11, file: "module_11.js", factoryFunctionIndex: 11, deps: [] },
      { id: 30, file: "module_30.js", factoryFunctionIndex: 30, deps: [11, 40, 41] },
      { id: 40, file: "module_40.js", factoryFunctionIndex: 40, deps: [] },
      { id: 41, file: "module_41.js", factoryFunctionIndex: 41, deps: [] },
    ] }) ],
    [
      "index.js",
      `require('./module_11.js');\nrequire('./module_30.js');\nrequire('./module_40.js');\nrequire('./module_41.js');\nvar __hbc_split_Module = require("module");\nvar __hbc_split_origLoad = __hbc_split_Module._load;\n__hbc_split_Module._load = function (request, parent, isMain) {\n  var m = /^\\.\\/module_(\\d+)\\.js$/.exec(request);\n  if (m) return __r(Number(m[1]));\n  return __hbc_split_origLoad.apply(this, arguments);\n};\n`,
    ],
    ["module_11.js", `// hbc2js --split -- Metro module 11\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 11, []);\n`],
    // Module 30: calls `.createStackNavigator` (§3.1 shape-alone gate), then
    // builds two screens' JSX props objects -- Home via the single-statement
    // require(dep).NamedExport compound shape, Profile via a plain register
    // that itself was resolved through a bracket-notation ["default"] hop.
    [
      "module_30.js",
      `// hbc2js --split -- Metro module 30\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n  let r0, r1, r2, r3, r4, r5, r6, r7, r8;\n  r2 = a2;\n  r1 = a7;\n  r0 = require('./module_11.js');\n  r5 = r0.createStackNavigator;\n  r0 = {};\n  r8 = "Home";\n  r0.name = r8;\n  r4 = r1[1];\n  r0.component = r2(r4).HomeComponent;\n  r6 = r1[2];\n  r3 = r2(r6);\n  r7 = r3["default"];\n  r0 = {};\n  r8 = "Profile";\n  r0.name = r8;\n  r0.component = r7;\n}\n\n__d(factory, 30, [11, 40, 41]);\n`,
    ],
    ["module_40.js", `// hbc2js --split -- Metro module 40\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 40, []);\n`],
    ["module_41.js", `// hbc2js --split -- Metro module 41\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 41, []);\n`],
  ]);

  const seg = segregateSplitTree(files, null); // no deps report -- shape alone, same as Service NSW's own fast path
  const byId = new Map(seg.modules.map((m) => [m.id, m]));
  assert.equal(byId.get(30)!.bucket, "src");
  assert.equal(byId.get(30)!.newPath, "src/navigation/StackNavigator.js");
  assert.equal(byId.get(40)!.newPath, "src/screens/HomeScreen.js", "single-statement require(dep).NamedExport should resolve module 30's Home route to module 40");
  assert.equal(byId.get(41)!.newPath, "src/screens/ProfileScreen.js", "a bracket-notation [\"default\"] interop hop should resolve module 30's Profile route to module 41");
});

// 2026-09-02 (Service NSW brief, naming half): Fred's own review flagged
// `StackNavigator.2.js` -- type + collision counter, not the app name --
// as a bad output. Fix: name a navigator from its own route set's common
// name prefix (Licence/LicenceLinking/LicenceScanner -> `Licence`) instead
// of its react-navigation call-shape kind, which is identical ("Stack")
// across every stack navigator in a real app and is exactly why they
// collide into ordinal suffixes in the first place.
void test("segregate: names a navigator from its route set's common prefix (Licence/LicenceLinking/LicenceScanner -> LicenceNavigator), not its call-shape kind", () => {
  const files = new Map<string, string>([
    ["MODULES.json", JSON.stringify({ hbcVersion: 98, moduleCount: 5, entry: null, modules: [
      { id: 11, file: "module_11.js", factoryFunctionIndex: 11, deps: [] },
      { id: 50, file: "module_50.js", factoryFunctionIndex: 50, deps: [11, 60, 61, 62] },
      { id: 60, file: "module_60.js", factoryFunctionIndex: 60, deps: [] },
      { id: 61, file: "module_61.js", factoryFunctionIndex: 61, deps: [] },
      { id: 62, file: "module_62.js", factoryFunctionIndex: 62, deps: [] },
    ] }) ],
    [
      "index.js",
      `require('./module_11.js');\nrequire('./module_50.js');\nrequire('./module_60.js');\nrequire('./module_61.js');\nrequire('./module_62.js');\nvar __hbc_split_Module = require("module");\nvar __hbc_split_origLoad = __hbc_split_Module._load;\n__hbc_split_Module._load = function (request, parent, isMain) {\n  var m = /^\\.\\/module_(\\d+)\\.js$/.exec(request);\n  if (m) return __r(Number(m[1]));\n  return __hbc_split_origLoad.apply(this, arguments);\n};\n`,
    ],
    ["module_11.js", `// hbc2js --split -- Metro module 11\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 11, []);\n`],
    // Module 50: calls `.createStackNavigator` (§3.1 shape-alone gate),
    // then builds three screens' JSX props objects, all sharing the
    // `Licence` route-name prefix.
    [
      "module_50.js",
      `// hbc2js --split -- Metro module 50\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n  let r0, r1, r2, r3, r4, r5, r6, r7, r8;\n  r2 = a2;\n  r1 = a7;\n  r0 = require('./module_11.js');\n  r5 = r0.createStackNavigator;\n  r4 = r1[1];\n  r3 = r2(r4);\n  r0 = {};\n  r8 = "Licence";\n  r0.name = r8;\n  r0.component = r3;\n  r4 = r1[2];\n  r3 = r2(r4);\n  r0 = {};\n  r8 = "LicenceLinking";\n  r0.name = r8;\n  r0.component = r3;\n  r4 = r1[3];\n  r3 = r2(r4);\n  r0 = {};\n  r8 = "LicenceScanner";\n  r0.name = r8;\n  r0.component = r3;\n}\n\n__d(factory, 50, [11, 60, 61, 62]);\n`,
    ],
    ["module_60.js", `// hbc2js --split -- Metro module 60\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 60, []);\n`],
    ["module_61.js", `// hbc2js --split -- Metro module 61\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 61, []);\n`],
    ["module_62.js", `// hbc2js --split -- Metro module 62\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 62, []);\n`],
  ]);

  const seg = segregateSplitTree(files, null); // no deps report -- shape alone, same as Service NSW's own fast path
  const byId = new Map(seg.modules.map((m) => [m.id, m]));
  assert.equal(byId.get(50)!.bucket, "src");
  assert.equal(byId.get(50)!.newPath, "src/navigation/LicenceNavigator.js", "a navigator whose own routes share the Licence prefix should be named from that prefix, not its call-shape kind (StackNavigator)");
  assert.equal(byId.get(60)!.newPath, "src/screens/LicenceScreen.js");
  assert.equal(byId.get(61)!.newPath, "src/screens/LicenceLinkingScreen.js");
  assert.equal(byId.get(62)!.newPath, "src/screens/LicenceScannerScreen.js");
});

// 2026-09-02 (Service NSW brief, §3.1 "container role" fallback): the gap
// the route-set-prefix pass above left open (docs/BUGS.md's cross-module
// route-config walk row) -- a navigator whose own route set has NO common
// prefix at all because it merges several unrelated domains, the real
// shape of Service NSW's own root/tab container. Four routes across four
// domains (Home/Wallet/Services/Support), no plurality domain (each
// appears once) -- falls to the deterministic role name, not the generic
// call-shape name.
void test("segregate: names a navigator with several unrelated route domains and no plurality (root/tab container) RootNavigator, not the generic call-shape name", () => {
  const files = new Map<string, string>([
    ["MODULES.json", JSON.stringify({ hbcVersion: 98, moduleCount: 6, entry: null, modules: [
      { id: 11, file: "module_11.js", factoryFunctionIndex: 11, deps: [] },
      { id: 70, file: "module_70.js", factoryFunctionIndex: 70, deps: [11, 80, 81, 82, 83] },
      { id: 80, file: "module_80.js", factoryFunctionIndex: 80, deps: [] },
      { id: 81, file: "module_81.js", factoryFunctionIndex: 81, deps: [] },
      { id: 82, file: "module_82.js", factoryFunctionIndex: 82, deps: [] },
      { id: 83, file: "module_83.js", factoryFunctionIndex: 83, deps: [] },
    ] }) ],
    [
      "index.js",
      `require('./module_11.js');\nrequire('./module_70.js');\nrequire('./module_80.js');\nrequire('./module_81.js');\nrequire('./module_82.js');\nrequire('./module_83.js');\nvar __hbc_split_Module = require("module");\nvar __hbc_split_origLoad = __hbc_split_Module._load;\n__hbc_split_Module._load = function (request, parent, isMain) {\n  var m = /^\\.\\/module_(\\d+)\\.js$/.exec(request);\n  if (m) return __r(Number(m[1]));\n  return __hbc_split_origLoad.apply(this, arguments);\n};\n`,
    ],
    ["module_11.js", `// hbc2js --split -- Metro module 11\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 11, []);\n`],
    // Module 70: calls `.createStackNavigator`, then registers four screens
    // across four unrelated domains -- no shared prefix, no plurality.
    [
      "module_70.js",
      `// hbc2js --split -- Metro module 70\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n  let r0, r1, r2, r3, r4, r5, r6, r7, r8;\n  r2 = a2;\n  r1 = a7;\n  r0 = require('./module_11.js');\n  r5 = r0.createStackNavigator;\n  r4 = r1[1];\n  r3 = r2(r4);\n  r0 = {};\n  r8 = "Home";\n  r0.name = r8;\n  r0.component = r3;\n  r4 = r1[2];\n  r3 = r2(r4);\n  r0 = {};\n  r8 = "Wallet";\n  r0.name = r8;\n  r0.component = r3;\n  r4 = r1[3];\n  r3 = r2(r4);\n  r0 = {};\n  r8 = "Services";\n  r0.name = r8;\n  r0.component = r3;\n  r4 = r1[4];\n  r3 = r2(r4);\n  r0 = {};\n  r8 = "Support";\n  r0.name = r8;\n  r0.component = r3;\n}\n\n__d(factory, 70, [11, 80, 81, 82, 83]);\n`,
    ],
    ["module_80.js", `// hbc2js --split -- Metro module 80\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 80, []);\n`],
    ["module_81.js", `// hbc2js --split -- Metro module 81\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 81, []);\n`],
    ["module_82.js", `// hbc2js --split -- Metro module 82\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 82, []);\n`],
    ["module_83.js", `// hbc2js --split -- Metro module 83\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 83, []);\n`],
  ]);

  const seg = segregateSplitTree(files, null); // no deps report -- shape alone, same as Service NSW's own fast path
  const byId = new Map(seg.modules.map((m) => [m.id, m]));
  assert.equal(byId.get(70)!.newPath, "src/navigation/RootNavigator.js", "a navigator spanning several unrelated domains with no plurality should get the deterministic role name, not StackNavigator");
});

// Same shape as above, but the call is `createBottomTabNavigator` (a real
// react-navigation tab factory, §3.1's kind-detection regex) -- the role
// name should reflect the tab container specifically, not the generic
// "Root" fallback.
void test("segregate: names a diverse-domain BOTTOM TAB navigator MainTabNavigator, not RootNavigator", () => {
  const files = new Map<string, string>([
    ["MODULES.json", JSON.stringify({ hbcVersion: 98, moduleCount: 6, entry: null, modules: [
      { id: 11, file: "module_11.js", factoryFunctionIndex: 11, deps: [] },
      { id: 71, file: "module_71.js", factoryFunctionIndex: 71, deps: [11, 84, 85, 86, 87] },
      { id: 84, file: "module_84.js", factoryFunctionIndex: 84, deps: [] },
      { id: 85, file: "module_85.js", factoryFunctionIndex: 85, deps: [] },
      { id: 86, file: "module_86.js", factoryFunctionIndex: 86, deps: [] },
      { id: 87, file: "module_87.js", factoryFunctionIndex: 87, deps: [] },
    ] }) ],
    [
      "index.js",
      `require('./module_11.js');\nrequire('./module_71.js');\nrequire('./module_84.js');\nrequire('./module_85.js');\nrequire('./module_86.js');\nrequire('./module_87.js');\nvar __hbc_split_Module = require("module");\nvar __hbc_split_origLoad = __hbc_split_Module._load;\n__hbc_split_Module._load = function (request, parent, isMain) {\n  var m = /^\\.\\/module_(\\d+)\\.js$/.exec(request);\n  if (m) return __r(Number(m[1]));\n  return __hbc_split_origLoad.apply(this, arguments);\n};\n`,
    ],
    ["module_11.js", `// hbc2js --split -- Metro module 11\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 11, []);\n`],
    [
      "module_71.js",
      `// hbc2js --split -- Metro module 71\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n  let r0, r1, r2, r3, r4, r5, r6, r7, r8;\n  r2 = a2;\n  r1 = a7;\n  r0 = require('./module_11.js');\n  r5 = r0.createBottomTabNavigator;\n  r4 = r1[1];\n  r3 = r2(r4);\n  r0 = {};\n  r8 = "Home";\n  r0.name = r8;\n  r0.component = r3;\n  r4 = r1[2];\n  r3 = r2(r4);\n  r0 = {};\n  r8 = "Wallet";\n  r0.name = r8;\n  r0.component = r3;\n  r4 = r1[3];\n  r3 = r2(r4);\n  r0 = {};\n  r8 = "Services";\n  r0.name = r8;\n  r0.component = r3;\n  r4 = r1[4];\n  r3 = r2(r4);\n  r0 = {};\n  r8 = "Support";\n  r0.name = r8;\n  r0.component = r3;\n}\n\n__d(factory, 71, [11, 84, 85, 86, 87]);\n`,
    ],
    ["module_84.js", `// hbc2js --split -- Metro module 84\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 84, []);\n`],
    ["module_85.js", `// hbc2js --split -- Metro module 85\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 85, []);\n`],
    ["module_86.js", `// hbc2js --split -- Metro module 86\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 86, []);\n`],
    ["module_87.js", `// hbc2js --split -- Metro module 87\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 87, []);\n`],
  ]);

  const seg = segregateSplitTree(files, null);
  const byId = new Map(seg.modules.map((m) => [m.id, m]));
  assert.equal(byId.get(71)!.newPath, "src/navigation/MainTabNavigator.js", "a diverse-domain createBottomTabNavigator-shaped navigator should be named MainTabNavigator, not the generic Root fallback");
});

// A navigator whose route set has no shared prefix but IS dominated by one
// domain (three Licence* routes plus one unrelated outlier) should still
// get a real domain name (LicenceNavigator), not the Root/MainTab role
// name -- the role-name fallback is for genuinely diverse route sets only.
void test("segregate: names a navigator with a dominant route domain plus one outlier from that domain, not Root", () => {
  const files = new Map<string, string>([
    ["MODULES.json", JSON.stringify({ hbcVersion: 98, moduleCount: 6, entry: null, modules: [
      { id: 11, file: "module_11.js", factoryFunctionIndex: 11, deps: [] },
      { id: 72, file: "module_72.js", factoryFunctionIndex: 72, deps: [11, 88, 89, 90, 91] },
      { id: 88, file: "module_88.js", factoryFunctionIndex: 88, deps: [] },
      { id: 89, file: "module_89.js", factoryFunctionIndex: 89, deps: [] },
      { id: 90, file: "module_90.js", factoryFunctionIndex: 90, deps: [] },
      { id: 91, file: "module_91.js", factoryFunctionIndex: 91, deps: [] },
    ] }) ],
    [
      "index.js",
      `require('./module_11.js');\nrequire('./module_72.js');\nrequire('./module_88.js');\nrequire('./module_89.js');\nrequire('./module_90.js');\nrequire('./module_91.js');\nvar __hbc_split_Module = require("module");\nvar __hbc_split_origLoad = __hbc_split_Module._load;\n__hbc_split_Module._load = function (request, parent, isMain) {\n  var m = /^\\.\\/module_(\\d+)\\.js$/.exec(request);\n  if (m) return __r(Number(m[1]));\n  return __hbc_split_origLoad.apply(this, arguments);\n};\n`,
    ],
    ["module_11.js", `// hbc2js --split -- Metro module 11\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 11, []);\n`],
    // Module 72: three Licence* routes (LicenceScan/LicenceRenew/
    // LicenceHistory) plus one unrelated outlier (Profile) -- no shared
    // prefix across all four, but Licence is a clear plurality (3 of 4).
    [
      "module_72.js",
      `// hbc2js --split -- Metro module 72\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n  let r0, r1, r2, r3, r4, r5, r6, r7, r8;\n  r2 = a2;\n  r1 = a7;\n  r0 = require('./module_11.js');\n  r5 = r0.createStackNavigator;\n  r4 = r1[1];\n  r3 = r2(r4);\n  r0 = {};\n  r8 = "LicenceScan";\n  r0.name = r8;\n  r0.component = r3;\n  r4 = r1[2];\n  r3 = r2(r4);\n  r0 = {};\n  r8 = "LicenceRenew";\n  r0.name = r8;\n  r0.component = r3;\n  r4 = r1[3];\n  r3 = r2(r4);\n  r0 = {};\n  r8 = "LicenceHistory";\n  r0.name = r8;\n  r0.component = r3;\n  r4 = r1[4];\n  r3 = r2(r4);\n  r0 = {};\n  r8 = "Profile";\n  r0.name = r8;\n  r0.component = r3;\n}\n\n__d(factory, 72, [11, 88, 89, 90, 91]);\n`,
    ],
    ["module_88.js", `// hbc2js --split -- Metro module 88\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 88, []);\n`],
    ["module_89.js", `// hbc2js --split -- Metro module 89\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 89, []);\n`],
    ["module_90.js", `// hbc2js --split -- Metro module 90\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 90, []);\n`],
    ["module_91.js", `// hbc2js --split -- Metro module 91\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 91, []);\n`],
  ]);

  const seg = segregateSplitTree(files, null);
  const byId = new Map(seg.modules.map((m) => [m.id, m]));
  assert.equal(byId.get(72)!.newPath, "src/navigation/LicenceNavigator.js", "a navigator dominated by one route domain should be named from that domain, not Root");
});

// 2026-09-02 (Service NSW cross-module route-config brief, docs/reports/
// 2026-09-02-navigator-naming-nsw-blocker.md): the actual blocker three
// prior agents each hit and correctly refused to paper over with a same-
// module heuristic -- Service NSW's own route names and `.component`
// targets live in a SEPARATE module from the navigator that consumes them,
// walked at runtime via `Object.entries(routeConfig)`, never as literal
// per-route pairs in the navigator module's own text. Hand-built here (the
// real bundle can't be committed, AGENT-BRIEF.md "local-corpus... NEVER in
// the repo") from the exact shape confirmed by reading Service NSW's own
// decompiled `routeConfig` module by hand:
//  - module 100 (the route-config *factory*, `looksLikeRouteConfigFactory`):
//    a debug-named `routeConfig` function builds a registry object
//    incrementally (`reg.LicenceScan = {component, ...}`), resolving one
//    target (101) through a direct `require()` + `["default"]` interop hop
//    and the other (102) through Service NSW's own `Reflect.apply(require,
//    undefined, [depmapIndex])` call spelling plus a closure-captured
//    `_eN_M` environment slot for the require/dependencyMap parameters --
//    both needed real fixes to this scan (`reflectTarget`, `envAliasTarget`/
//    `envAliasTarget2`, the two-pass warm-up for the slot's write-after-read
//    text ordering), not just the registry-shape recognition itself.
//  - module 200 (the *consumer*, `detectRouteConfigConsumer`): a navigator
//    that never builds a route map of its own, only requires module 100 and
//    walks `Object.entries(<its routeConfig>)` -- real cross-module
//    dataflow: its own route set for naming purposes is borrowed from its
//    *dependency*'s already-resolved hits, not anything in its own text.
void test("segregate: cross-module route-config walk -- a route-config factory in one module, consumed via Object.entries() by a navigator in another (Service NSW shape)", () => {
  const files = new Map<string, string>([
    ["MODULES.json", JSON.stringify({ hbcVersion: 98, moduleCount: 4, entry: null, modules: [
      { id: 100, file: "module_100.js", factoryFunctionIndex: 100, deps: [101, 102] },
      { id: 101, file: "module_101.js", factoryFunctionIndex: 101, deps: [] },
      { id: 102, file: "module_102.js", factoryFunctionIndex: 102, deps: [] },
      { id: 200, file: "module_200.js", factoryFunctionIndex: 200, deps: [100] },
    ] }) ],
    [
      "index.js",
      `require('./module_100.js');\nrequire('./module_101.js');\nrequire('./module_102.js');\nrequire('./module_200.js');\nvar __hbc_split_Module = require("module");\nvar __hbc_split_origLoad = __hbc_split_Module._load;\n__hbc_split_Module._load = function (request, parent, isMain) {\n  var m = /^\\.\\/module_(\\d+)\\.js$/.exec(request);\n  if (m) return __r(Number(m[1]));\n  return __hbc_split_origLoad.apply(this, arguments);\n};\n`,
    ],
    // Module 100: the route-config factory, named `routeConfig` in the
    // debug function-name table (preserved as this comment by `--split`)
    // and exporting itself under the matching `.routeConfig` property --
    // both signals `looksLikeRouteConfigFactory` checks for. The nested
    // `_fn100` mirrors Service NSW's own closure-capture shape: the
    // require/dependencyMap parameters are copied into `_e1_0`/`_e1_1`
    // *after* `_fn100`'s own declaration in the text, even though that copy
    // always runs first at runtime -- the write-after-read ordering the
    // two-pass warm-up scan exists to handle.
    [
      "module_100.js",
      `// hbc2js --split -- Metro module 100\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n  let r0, r2, r3, r5, r6;\n  let _e1_0, _e1_1, _e1_2;\n  function _fn100(a1) {\n    // fn#100 "routeConfig"\n    let r0, r3, r14, r17, r19, r20;\n    r19 = _e1_0;\n    r20 = _e1_1;\n    r17 = undefined;\n    r14 = {};\n    r0 = {};\n    r3 = _e1_2;\n    r3 = r3["default"];\n    r0.component = r3;\n    r14.LicenceScan = r0;\n    r0 = {};\n    r3 = r20[1];\n    r3 = Reflect.apply(r19, r17, [r3]);\n    r3 = r3.LicenceRenewComponent;\n    r0.component = r3;\n    r14.LicenceRenew = r0;\n    return r14;\n  }\n  r5 = a2;\n  r2 = a6;\n  r6 = a7;\n  _e1_0 = r5;\n  _e1_1 = r6;\n  r3 = require('./module_101.js');\n  _e1_2 = r3;\n  r2.routeConfig = _fn100;\n  return r2;\n}\n\n__d(factory, 100, [101, 102]);\n`,
    ],
    ["module_101.js", `// hbc2js --split -- Metro module 101\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 101, []);\n`],
    ["module_102.js", `// hbc2js --split -- Metro module 102\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 102, []);\n`],
    // Module 200: the consumer -- never builds a route map itself, only
    // requires module 100 and walks `Object.entries(<its routeConfig>)`.
    // No `create<X>Navigator` call in sight (`detectNavigatorKind` alone
    // would score zero), so recognising this as a navigator at all, and
    // naming it from a route set that is entirely absent from its own text,
    // is the cross-module half of this walk.
    [
      "module_200.js",
      `// hbc2js --split -- Metro module 200\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n  let r0, r1, r2;\n  r0 = require('./module_100.js');\n  r1 = r0.routeConfig;\n  r2 = globalThis.Object;\n  r2 = r2.entries(r1);\n  return r2;\n}\n\n__d(factory, 200, [100]);\n`,
    ],
  ]);

  const seg = segregateSplitTree(files, null); // no deps report -- shape alone, same as Service NSW's own fast path
  const byId = new Map(seg.modules.map((m) => [m.id, m]));
  assert.equal(byId.get(101)!.newPath, "src/screens/LicenceScanScreen.js", "the require()+[\"default\"]-resolved route should name its target module");
  assert.equal(byId.get(102)!.newPath, "src/screens/LicenceRenewScreen.js", "the Reflect.apply(require, undefined, [depmapIndex])-resolved route should name its target module");
  assert.equal(byId.get(200)!.bucket, "src");
  assert.equal(byId.get(200)!.newPath, "src/navigation/LicenceNavigator.js", "the Object.entries(routeConfig) consumer should be named from its dependency's route set, not left generic");
});

// 2026-09-02 (Service NSW route-resolution follow-up, docs/BUGS.md's
// "root, remaining gaps" row on the cross-module walk task above): the
// tracked, not-yet-handled shape -- a route's depmap index compiled as TWO
// statements (`r8 = 1; r3 = r20[r8];`, a numeric literal assigned to a
// plain register then used as a *variable* bracket index) rather than one
// (`r20[1]`, already handled by `idxTarget`'s own literal-digit bracket
// alternative). Confirmed by hand as a real Service NSW compiled shape
// (Hermes register allocation sometimes hoists a small integer constant
// into its own register before indexing, rather than folding it into the
// bracket). Otherwise identical to the existing `Reflect.apply` route-
// config-factory fixture above (module 300 = factory named
// `FooNavigationRoutes`, module 301 = the require()d screen target) so this
// isolates exactly the one new resolution step (`idxRegRef`/`numLitByReg`
// in `traceModuleOrigins`) rather than re-testing the whole cross-module
// walk again.
void test("segregate: resolves a route whose depmap index is built as two statements (`r = N; r = arr[r];`), not one", () => {
  const files = new Map<string, string>([
    ["MODULES.json", JSON.stringify({ hbcVersion: 98, moduleCount: 2, entry: null, modules: [
      { id: 300, file: "module_300.js", factoryFunctionIndex: 300, deps: [301] },
      { id: 301, file: "module_301.js", factoryFunctionIndex: 301, deps: [] },
    ] }) ],
    [
      "index.js",
      `require('./module_300.js');\nrequire('./module_301.js');\nvar __hbc_split_Module = require("module");\nvar __hbc_split_origLoad = __hbc_split_Module._load;\n__hbc_split_Module._load = function (request, parent, isMain) {\n  var m = /^\\.\\/module_(\\d+)\\.js$/.exec(request);\n  if (m) return __r(Number(m[1]));\n  return __hbc_split_origLoad.apply(this, arguments);\n};\n`,
    ],
    [
      "module_300.js",
      `// hbc2js --split -- Metro module 300\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n  let r0, r2, r3, r8, r14, r17, r19, r20;\n  // fn#300 "FooNavigationRoutes"\n  r19 = a2;\n  r20 = a7;\n  r17 = undefined;\n  r14 = {};\n  r0 = {};\n  r8 = 0;\n  r3 = r20[r8];\n  r3 = Reflect.apply(r19, r17, [r3]);\n  r0.component = r3;\n  r14.LicenceRenew = r0;\n  r2 = a6;\n  r2.FooNavigationRoutes = r14;\n  return r2;\n}\n\n__d(factory, 300, [301]);\n`,
    ],
    ["module_301.js", `// hbc2js --split -- Metro module 301\nfunction factory(a1, a2, a3, a4, a5, a6, a7) {\n}\n\n__d(factory, 301, []);\n`],
  ]);

  const seg = segregateSplitTree(files, null);
  const byId = new Map(seg.modules.map((m) => [m.id, m]));
  assert.equal(byId.get(301)!.newPath, "src/screens/LicenceRenewScreen.js", "a route whose Reflect.apply depmap index is built as two statements (literal into a register, then bracket-indexed by that register) should still resolve its target module");
});

// Milestone 3's own acceptance fixture (docs/specs/08-segregation.md §5/§6
// milestone 3, §6.3): react-navigation-example-0.85.3, a real router-heavy
// app -- rn-template-0.72 (used by every other test in this file) ships no
// navigation at all (§5's own table: 0 navigators/screens there, correctly).
// Uncommitted (`tests/fixtures/bundles/react-navigation-example-0.85.3/
// fetch.sh`, same convention as tests/gate/deps/match.test.ts's "uncommitted
// react-navigation-example bundle" note) -- skips rather than fails when
// not fetched, so a fresh clone's `npm test` still passes.
const REACT_NAV_EXAMPLE = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.hbc");

void test("segregate: detects real navigators/screens on react-navigation-example-0.85.3 (milestone 3 acceptance fixture)", async (t) => {
  if (!existsSync(REACT_NAV_EXAMPLE)) {
    t.skip(`react-navigation-example-0.85.3 not fetched (run tests/fixtures/bundles/react-navigation-example-0.85.3/fetch.sh)`);
    return;
  }
  const bytes = readFileSync(REACT_NAV_EXAMPLE);
  const split = splitProject(bytes, { moduleName: "react-navigation-example.hbc" });
  const depsRun = await runDeps(REACT_NAV_EXAMPLE, { offline: true });
  const seg = segregateSplitTree(split.files, depsRun.report);

  const screens = seg.modules.filter((m) => m.nameSignal?.startsWith("screen-route"));
  const navigators = seg.modules.filter((m) => m.nameSignal?.startsWith("navigator"));
  assert.ok(screens.length > 0, "expected at least one screen detected on react-navigation-example-0.85.3");
  assert.ok(navigators.length > 0, "expected at least one navigator detected on react-navigation-example-0.85.3");
  // Hard regression bar (2026-09-02, Service NSW `Reflect.apply`-hop brief):
  // this fixture's own §6 milestone-3 numbers, pinned exactly -- any
  // Service-NSW-motivated change to `traceModuleOrigins`'s resolution shapes
  // must not move these (a prior, reverted attempt did: 4->3 navigators,
  // 54->67 screens, by over-matching unrelated call sites elsewhere in this
  // fixture's larger modules -- NOT the same change as the correction
  // below, which moves modules out of `src` entirely rather than changing
  // which calls resolve).
  //
  // CORRECTED 2026-09-02 (P-10, PUSHBACK.md; docs/specs/08-segregation.md
  // §6): 4/54 -> 3/50. `segregateSplitTree` used to bucket every module by
  // classify.ts's heuristic `classification` alone; module 1122, a pure
  // `@react-navigation/native` barrel/index (every top-level statement is a
  // lazy `get` accessor re-exporting one of the package's exports --
  // `createStaticNavigation`, `Link`, `LinkingContext`, ... -- never a call,
  // never a route registry) was misclassified CUSTOM by the app-vocabulary
  // signal (those re-exported names shape-match the app's own PascalCase
  // Screen/Navigator vocabulary token) and filed to `src/`, where it was
  // then miscounted as a 4th app navigator. `runDeps --offline`'s own
  // `moduleOwnership` (hash-matched against the signature DB, confirmed-
  // tier only) already resolves module 1122 itself to `@react-navigation/
  // native` directly -- stronger, independently-derived evidence than
  // classify.ts's heuristic -- so segregation now takes that confirmed
  // per-module ownership over classify.ts's classification when the two
  // disagree. Ground truth (this fixture's `deps-truth.json`, built from
  // the example app's real npm install, test-only and never read by
  // production code) confirms module 1122 really is `@react-navigation/
  // native`. The fixture's other 3 nameSignal-"navigator" modules were
  // hand-checked against that same ground truth and are unaffected: 1086
  // (`package: null`) has a real route registry (`X.App =`/`X.Home =`/...)
  // and is genuinely app code; 1641 (`package: null`, source ending
  // `.../MyStackNavigator.tsx`) has real per-route logic, not a barrel
  // shape, also genuinely app code; 1611 IS a `@react-navigation/material-
  // top-tabs` barrel by that same ground truth but stays misfiled --
  // `material-top-tabs` isn't in the signature DB at all, so match.ts never
  // confirms it and there is no `moduleOwnership` entry to act on (BUGS.md
  // follow-up: extend the signature DB to `@react-navigation/material-top-
  // tabs`, then this module moves too, without further segregate.ts
  // changes). Screens 54->50: the 4 screens dropped are ones whose target
  // module was module 1122 itself (`hitsByTarget`/`detectScreenHits`'s
  // guard already requires `classByModule.get(hit.targetId) === "custom"`,
  // and 1122 is no longer in the `src`-bucket `srcModules` set naming even
  // considers, since bucketing now runs before naming).
  assert.equal(navigators.length, 3, "react-navigation-example WITH deps: navigator count regressed from its pinned §6 value");
  assert.equal(screens.length, 50, "react-navigation-example WITH deps: screen count regressed from its pinned §6 value");
  for (const s of screens) assert.match(s.newPath, /^src\/screens\//, `screen ${s.newPath} not filed under src/screens/`);
  for (const n of navigators) assert.match(n.newPath, /^src\/navigation\//, `navigator ${n.newPath} not filed under src/navigation/`);

  // No collisions across the whole tree.
  const pathCounts = new Map<string, number>();
  for (const m of seg.modules) pathCounts.set(m.newPath, (pathCounts.get(m.newPath) ?? 0) + 1);
  for (const [path, count] of pathCounts) assert.equal(count, 1, `${count} modules collided on ${path}`);

  // §4.1 structural byte-diff: every module's factory body, modulo
  // require() targets and the rename header, is unchanged.
  for (const m of split.modules) {
    const before = split.files.get(m.file);
    const after = seg.files.get(seg.modules.find((s) => s.id === m.id)!.newPath);
    assert.ok(before !== undefined && after !== undefined, `module ${m.id} missing before/after text`);
    assert.equal(normaliseRequireTargets(after!), normaliseRequireTargets(before!), `module ${m.id}'s factory body changed during segregation`);
  }

  // §4.2 boot-still-works: not run here -- `--split` itself already reports
  // a module-level scope-check diagnostic on this fixture (an existing,
  // unrelated decompile-emission gap on this real bundle, tracked
  // separately from segregation), so a boot-split re-run on this
  // particular fixture is not a clean signal for segregation's own
  // correctness. rn-template-0.72's test above already exercises §4.2's
  // boot-equivalence proof end-to-end; this test's byte-diff (above) is
  // segregation's half of the correctness story on this fixture.
});

// 2026-09-02 (Service NSW brief): the whole point -- Service NSW's own
// `deps` run takes >10 min, so navigator/screen detection has to work with
// NO deps report at all, not just a slow one. Same real fixture as above,
// `segregateSplitTree(split.files, null)` this time.
void test("segregate: detects navigators/screens on react-navigation-example-0.85.3 with NO --deps-report (call/config shape alone)", () => {
  if (!existsSync(REACT_NAV_EXAMPLE)) {
    return; // covered by the WITH-deps test's own skip above; avoid a duplicate skip line
  }
  const bytes = readFileSync(REACT_NAV_EXAMPLE);
  const split = splitProject(bytes, { moduleName: "react-navigation-example.hbc" });
  const seg = segregateSplitTree(split.files, null);

  const screens = seg.modules.filter((m) => m.nameSignal?.startsWith("screen-route"));
  const navigators = seg.modules.filter((m) => m.nameSignal?.startsWith("navigator"));
  assert.ok(screens.length > 0, "expected at least one screen detected on react-navigation-example-0.85.3 with no deps report");
  assert.ok(navigators.length > 0, "expected at least one navigator detected on react-navigation-example-0.85.3 with no deps report");
  // Hard regression bar, WITHOUT deps -- same pinning rationale as the
  // WITH-deps test above (2026-09-02, Service NSW brief).
  //
  // 2026-09-02 (generalization-sweep brief, Brex/Uniswap false-positive
  // fix): screens re-pinned 58 -> 52. The 6 dropped were themselves false
  // positives of the exact bug this brief fixes, bundled inside this
  // fixture's own dependency tree -- confirmed by hand, module 582 (an
  // unrelated font-weight-constants module, no navigator anywhere in
  // sight) has `r4 = {VALID_FONT_WEIGHTS: null, FONT_WEIGHT_MAPPINGS: null,
  // ERROR_MESSAGES: null}; r4.FONT_WEIGHT_MAPPINGS = <required module>;` --
  // the identical shape-match-with-no-navigator-connection root cause
  // reported on Rainbow/Bluesky (`FONT_WEIGHT_MAPPINGSScreen`,
  // `SLOPE_FACTORScreen`, named verbatim in that report) and now on this
  // fixture too, only visible once the real fix (route-registry literal
  // gated on navigator-connection, `traceModuleOrigins`) stopped accepting
  // it. Not a "trust me, update the test" ask -- this is the bug the brief
  // named, on this fixture's own bundled deps, confirmed independently
  // above. The WITH-deps test's pinned 50 (§6) is unaffected: `deps`
  // classifies module 582 as a library dependency, already excluded from
  // naming there regardless of this fix.
  assert.equal(navigators.length, 6, "react-navigation-example WITHOUT deps: navigator count regressed from its pinned §6 value");
  assert.equal(screens.length, 52, "react-navigation-example WITHOUT deps: screen count regressed from its pinned §6 value (generalization-sweep re-pin, see comment above)");
  for (const s of screens) assert.match(s.newPath, /^src\/screens\//, `screen ${s.newPath} not filed under src/screens/`);
  for (const n of navigators) assert.match(n.newPath, /^src\/navigation\//, `navigator ${n.newPath} not filed under src/navigation/`);
  // No deps report -> every navigator/screen candidate lands at the shape-
  // alone confidence tier or below (never the deps-confirmed 0.9 tier,
  // which needs a moduleOwnership match this run never has).
  for (const n of navigators) assert.ok(n.nameConfidence! <= 0.6, `navigator ${n.newPath} confidence ${n.nameConfidence} unexpectedly deps-confirmed with no deps report`);

  // §4.1 structural byte-diff still holds with no deps report: only
  // require() targets and the rename header may differ.
  for (const m of split.modules) {
    const before = split.files.get(m.file);
    const after = seg.files.get(seg.modules.find((s) => s.id === m.id)!.newPath);
    assert.ok(before !== undefined && after !== undefined, `module ${m.id} missing before/after text`);
    assert.equal(normaliseRequireTargets(after!), normaliseRequireTargets(before!), `module ${m.id}'s factory body changed during no-deps segregation`);
  }
});
