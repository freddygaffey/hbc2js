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
import { splitProject } from "../../../src/split/index.ts";
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
  // fixture's larger modules).
  assert.equal(navigators.length, 4, "react-navigation-example WITH deps: navigator count regressed from its pinned §6 value");
  assert.equal(screens.length, 54, "react-navigation-example WITH deps: screen count regressed from its pinned §6 value");
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
  assert.equal(navigators.length, 6, "react-navigation-example WITHOUT deps: navigator count regressed from its pinned §6 value");
  assert.equal(screens.length, 58, "react-navigation-example WITHOUT deps: screen count regressed from its pinned §6 value");
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
