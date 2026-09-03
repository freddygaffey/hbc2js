// docs/specs/09-fuzzing.md §2.1 (source generator) + §2.3.1 (duplicate
// rejection): the seed must fully determine the generated app, and the
// manifest fingerprint is the dedup key. Gate-fast (no npm install, no
// network) — this is the unit-test layer; tools/appgen/build.mjs's actual
// npm-install-and-bundle build is proven separately (sweep tier, see
// tests/sweep/appgen/build.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateApp } from "../../tools/appgen/generate.mjs";
import { fingerprint, isDuplicate } from "../../tools/appgen/lib/manifest.mjs";

test("generateApp: same seed produces byte-identical manifest and file tree", () => {
  const a = generateApp(12345);
  const b = generateApp(12345);
  assert.deepEqual(a.manifest, b.manifest, "manifest must be identical for the same seed");
  assert.deepEqual([...a.files.keys()].sort(), [...b.files.keys()].sort(), "file set must be identical");
  for (const [path, content] of a.files) {
    assert.equal(content, b.files.get(path), `file content for ${path} must be byte-identical`);
  }
});

test("generateApp: different seeds vary at least one axis (router/depStyle/screens)", () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  const manifests = seeds.map((s) => generateApp(s).manifest);
  const routerShapes = new Set(manifests.map((m) => m.routerShape));
  const depStyles = new Set(manifests.map((m) => m.depStyle));
  // Across 8 distinct seeds we expect real variation on at least one axis --
  // a generator that always emitted the same shape would collapse this to 1.
  assert.ok(routerShapes.size > 1 || depStyles.size > 1, "axes should vary across seeds");
});

test("generateApp: router shape covers stack, tabs, and the weird mapped-array/barrel shape", () => {
  // Small deterministic seed scan, not a probabilistic property test: we
  // assert all three documented shapes (docs/specs/09-fuzzing.md §2.1 /
  // task brief) are reachable within a modest seed range.
  const shapes = new Set();
  for (let seed = 0; seed < 60; seed++) shapes.add(generateApp(seed).manifest.routerShape);
  assert.deepEqual(shapes, new Set(["stack", "tabs", "weird"]));
});

test("generateApp: dependency-loading style covers static import, lazy require, and re-export indirection", () => {
  const styles = new Set();
  for (let seed = 0; seed < 60; seed++) styles.add(generateApp(seed).manifest.depStyle);
  assert.deepEqual(styles, new Set(["static", "lazyRequire", "reexport"]));
});

test("generateApp: screen count is always 2-4 with distinct seeded names", () => {
  for (let seed = 0; seed < 30; seed++) {
    const { manifest } = generateApp(seed);
    assert.ok(manifest.screens.length >= 2 && manifest.screens.length <= 4, `seed ${seed}: screen count out of [2,4]`);
    assert.equal(new Set(manifest.screens).size, manifest.screens.length, `seed ${seed}: screen names must be distinct`);
  }
});

test("generateApp: 'weird' router shape builds routes from a mapped array over barrel-imported screens", () => {
  let found = false;
  for (let seed = 0; seed < 60 && !found; seed++) {
    const { manifest, files } = generateApp(seed);
    if (manifest.routerShape !== "weird") continue;
    found = true;
    const nav = files.get("src/navigation/index.js");
    assert.ok(nav !== undefined, "navigation/index.js must exist");
    assert.match(nav, /routeConfigs\s*=\s*\[/, "weird shape should build a route array literal");
    assert.match(nav, /routeConfigs\.map\(/, "weird shape should render routes via .map()");
    const barrel = files.get("src/screens/index.js");
    assert.ok(barrel !== undefined, "screens barrel must exist");
    assert.match(barrel, /export \{ default as .*Screen \} from/, "barrel should re-export screens");
  }
  assert.ok(found, "expected to find a 'weird' router-shape app within 60 seeds");
});

test("fingerprint: identical axes (router/depStyle/screens) dedup even under different seeds", () => {
  // Construct two manifests that share axes but differ in seed/appName --
  // fingerprint must ignore the seed and key off shape alone (spec §2.1:
  // "same-app-N-times is the defined failure").
  const m1 = { routerShape: "stack", depStyle: "static", screens: ["FooBar", "BazQux"] };
  const m2 = { routerShape: "stack", depStyle: "static", screens: ["BazQux", "FooBar"] }; // order-independent
  assert.equal(fingerprint(m1), fingerprint(m2));
});

test("fingerprint: a different axis changes the fingerprint", () => {
  const m1 = { routerShape: "stack", depStyle: "static", screens: ["FooBar", "BazQux"] };
  const m2 = { routerShape: "tabs", depStyle: "static", screens: ["FooBar", "BazQux"] };
  assert.notEqual(fingerprint(m1), fingerprint(m2));
});

test("isDuplicate: rejects a fingerprint already present in the manifest store", () => {
  const { manifest } = generateApp(999);
  const store = [{ id: "x", fingerprint: manifest.fingerprint }];
  assert.equal(isDuplicate(store, manifest.fingerprint), true);
  assert.equal(isDuplicate(store, "not-present"), false);
  assert.equal(isDuplicate([], manifest.fingerprint), false);
});
