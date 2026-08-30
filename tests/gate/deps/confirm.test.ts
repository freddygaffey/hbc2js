// docs/DECISIONS.md D17a §4 ("confirm") — exercises the write-back +
// D17b layering logic end-to-end with a *stubbed* npm/npx (no network, no
// real Metro/React Native): a fake `npm` copies a tiny fake package into
// `node_modules` for `npm install --ignore-scripts`, a fake `npx` writes a
// canned `__d()` bundle in place of a real `react-native bundle`, and the
// real, local `tools/hermesc` compiles it — so `confirmCandidates`'s own
// fingerprint/match/write-back code runs for real. Plus unit tests for the
// pure helpers (dedup, baseline subtraction, RN-version-from-baseline-
// filename fallback, nearest-by-date resolution).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireHermesc } from "../../support/hermesc.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import type { ModuleInventory } from "../../../src/deps/inventory.ts";
import { loadSignatures, writeSignature } from "../../../src/deps/db.ts";
import {
  computeBaselineHashes,
  confirmCandidates,
  dedupeCandidatesByPackage,
  detectRnVersionFromBaselineFilenames,
  hasCompleteBaselineSet,
  nearestVersionByDate,
  subtractBaseline,
} from "../../../src/deps/confirm.ts";
import type { ConfirmCandidate, ConfirmSuccess } from "../../../src/deps/confirm.ts";
import type { SigDbFile, SigFunction, SigModule } from "../../../src/deps/sigdb-types.ts";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// --- pure-helper unit tests ------------------------------------------------

test("dedupeCandidatesByPackage: collapses repeats per package, preferring a versioned candidate over a null one", () => {
  const input: ConfirmCandidate[] = [
    { package: "a", version: null },
    { package: "b", version: "1.0.0" },
    { package: "a", version: "2.0.0" }, // later, versioned — wins over the earlier null
    { package: "a", version: "3.0.0" }, // a versioned one is already kept — first wins
  ];
  const out = dedupeCandidatesByPackage(input);
  assert.equal(out.length, 2, "one entry per distinct package, not one per input row");
  assert.equal(out.find((c) => c.package === "a")!.version, "2.0.0");
  assert.equal(out.find((c) => c.package === "b")!.version, "1.0.0");
});

test("nearestVersionByDate: picks the closest publish date, ignoring created/modified keys", () => {
  const times = {
    created: "2000-01-01T00:00:00.000Z",
    modified: "2024-01-01T00:00:00.000Z",
    "1.0.0": "2020-01-01T00:00:00.000Z",
    "2.0.0": "2022-06-01T00:00:00.000Z",
    "3.0.0": "2023-01-01T00:00:00.000Z",
  };
  assert.equal(nearestVersionByDate(times, "2022-07-01T00:00:00.000Z"), "2.0.0");
  assert.equal(nearestVersionByDate(times, "2019-01-01T00:00:00.000Z"), "1.0.0");
  assert.equal(nearestVersionByDate({ created: "2000-01-01T00:00:00.000Z" }, "2022-01-01T00:00:00.000Z"), null, "only created/modified present — nothing to resolve to");
});

test("hasCompleteBaselineSet: true only once all three baseline kinds are represented", () => {
  assert.equal(hasCompleteBaselineSet([]), false);
  assert.equal(hasCompleteBaselineSet(["_baselines/react-foundation@1__hbc94.json"]), false);
  assert.equal(
    hasCompleteBaselineSet(["_baselines/react-foundation@1__hbc94.json", "_baselines/react-native-foundation@1__hbc94.json", "_baselines/metro-toolchain-empty@1__hbc94.json"]),
    true,
  );
});

test("computeBaselineHashes + subtractBaseline: drops baseline-hash functions, flags baseline factories, keeps everything else", () => {
  const dir = tmpDir("hbc2js-confirm-baseline-");
  try {
    mkdirSync(join(dir, "_baselines"), { recursive: true });
    writeFileSync(join(dir, "_baselines", "metro-toolchain-empty@0__hbc94.json"), JSON.stringify({ functions: [{ exactHash: "noise1" }, { exactHash: "noise2" }] }));
    // A second dir contributing a *different* baseline kind — the union
    // spans every dir given, not just the first.
    const dir2 = tmpDir("hbc2js-confirm-baseline2-");
    try {
      mkdirSync(join(dir2, "_baselines"), { recursive: true });
      writeFileSync(join(dir2, "_baselines", "react-foundation@1__hbc94.json"), JSON.stringify({ functions: [{ exactHash: "noise3" }] }));

      const { hashes, paths } = computeBaselineHashes([dir, dir2], 94);
      assert.deepEqual([...hashes].sort(), ["noise1", "noise2", "noise3"]);
      assert.equal(paths.length, 2);

      const rawFunctions: SigFunction[] = [
        { index: 0, name: "f0", paramCount: 0, instrCount: 10, exactHash: "noise1", fuzzyHash: "x", stringSetHash: "y", stringCount: 0 },
        { index: 1, name: "f1", paramCount: 0, instrCount: 10, exactHash: "real1", fuzzyHash: "x", stringSetHash: "y", stringCount: 0 },
      ];
      const rawModules: SigModule[] = [
        { factoryFunctionIndex: 0, localModuleId: 0, depCount: 0, depIds: [], factoryExactHash: "noise1", factoryFuzzyHash: null, nestedFunctionCount: 0, functionSetHash: "z", factoryIsBaseline: false },
        { factoryFunctionIndex: 1, localModuleId: 1, depCount: 0, depIds: [], factoryExactHash: "real1", factoryFuzzyHash: null, nestedFunctionCount: 0, functionSetHash: "z", factoryIsBaseline: false },
      ];
      const { functions, modules } = subtractBaseline(rawFunctions, rawModules, hashes);
      assert.deepEqual(functions.map((f) => f.exactHash), ["real1"], "the baseline-hash function is dropped, the real one kept");
      assert.equal(modules.length, 2, "modules are never dropped, only flagged");
      assert.equal(modules.find((m) => m.factoryFunctionIndex === 0)!.factoryIsBaseline, true);
      assert.equal(modules.find((m) => m.factoryFunctionIndex === 1)!.factoryIsBaseline, false);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectRnVersionFromBaselineFilenames: reads the RN version off a baseline filename for the given HBC version only", () => {
  const dir = tmpDir("hbc2js-confirm-rnver-");
  try {
    mkdirSync(join(dir, "_baselines"), { recursive: true });
    writeFileSync(join(dir, "_baselines", "react-native-foundation@0.85.3__hbc98.json"), "{}");
    assert.equal(detectRnVersionFromBaselineFilenames([dir], 98), "0.85.3");
    assert.equal(detectRnVersionFromBaselineFilenames([dir], 94), null, "must not match a different HBC version");
    assert.equal(detectRnVersionFromBaselineFilenames(["/nonexistent-dir-xyz"], 98), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- end-to-end confirmCandidates with a stubbed npm/npx (no network) -----

const FAKE_NPM = `#!/usr/bin/env node
"use strict";
const { mkdirSync, cpSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "install") {
  const spec = args.filter((a) => !a.startsWith("--")).pop();
  if (spec) {
    const pkg = spec.slice(0, spec.lastIndexOf("@"));
    const destDir = join(process.cwd(), "node_modules", ...pkg.split("/"));
    mkdirSync(destDir, { recursive: true });
    cpSync(process.env.HBC2JS_TEST_FAKE_PKG_DIR, destDir, { recursive: true });
  }
}
process.exit(0);
`;

const FAKE_NPX = `#!/usr/bin/env node
"use strict";
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--bundle-output");
const outPath = args[outIdx + 1];
writeFileSync(outPath, process.env.HBC2JS_TEST_FAKE_BUNDLE_JS || "");
process.exit(0);
`;

// Three substantial (>= 8 real instructions), distinct `__d()` module
// registrations — `moduleExactHits >= 3` alone clears "high" tier
// (docs/DEPS.md's confidence-tier table) regardless of package size, so
// compiling this same source twice (once for the "target", once standing in
// for the "candidate" package's own Metro bundle) deterministically
// reproduces a real, independently-verified high-confidence match without
// depending on any committed fixture or the network.
const CANNED_SOURCE = `
function __d(factory, moduleId, deps) {}
__d(function (global, require, importDefault, exportAll, module, exports, dependencyMap) {
  var total = 0;
  for (var i = 0; i < 37; i++) {
    total = total + i * 3 - (i % 5) + (i > 10 ? 2 : 1);
  }
  module.exports = total;
}, 0, []);
__d(function (global, require, importDefault, exportAll, module, exports, dependencyMap) {
  var s = "";
  for (var j = 0; j < 29; j++) {
    s = s + String.fromCharCode(65 + (j % 26));
  }
  module.exports = s;
}, 1, []);
__d(function (global, require, importDefault, exportAll, module, exports, dependencyMap) {
  var arr = [];
  for (var k = 0; k < 41; k++) {
    arr.push(k * k - k + 7);
  }
  module.exports = arr;
}, 2, []);
`;

test("confirmCandidates: write-back + D17b layering, end to end, with a stubbed npm/npx (no network)", async (t) => {
  const hermesc = requireHermesc(t, 94);
  if (hermesc === null) return;

  const work = tmpDir("hbc2js-confirm-e2e-");
  const binDir = join(work, "bin");
  const fakePkgDir = join(work, "fake-pkg");
  const scratchProjectDir = join(work, "scratch");
  const projectDbDir = join(work, "project-db");
  const userCacheDbDir = join(work, "user-cache-db");
  const staleSharedDbDir = join(work, "shared-db");
  const targetHbcPath = join(work, "target.hbc");
  const originalPath = process.env.PATH;

  try {
    // Fake npm/npx on PATH.
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "npm"), FAKE_NPM);
    chmodSync(join(binDir, "npm"), 0o755);
    writeFileSync(join(binDir, "npx"), FAKE_NPX);
    chmodSync(join(binDir, "npx"), 0o755);
    process.env.PATH = `${binDir}:${originalPath}`;

    // A minimal, harmless payload for the fake `npm install` to copy into
    // the scratch project's node_modules.
    mkdirSync(fakePkgDir, { recursive: true });
    writeFileSync(join(fakePkgDir, "package.json"), JSON.stringify({ name: "some-fake-pkg", version: "9.9.9" }));
    process.env.HBC2JS_TEST_FAKE_PKG_DIR = fakePkgDir;
    process.env.HBC2JS_TEST_FAKE_BUNDLE_JS = CANNED_SOURCE;

    // Pre-seed the scratch project's react-native so `ensureScratchProject`
    // never shells out to a real `npm install` (this test only stubs
    // `pack`/bundling, not RN installation).
    mkdirSync(join(scratchProjectDir, "node_modules", "react-native"), { recursive: true });
    writeFileSync(join(scratchProjectDir, "node_modules", "react-native", "package.json"), JSON.stringify({ name: "react-native", version: "0.0.0-test" }));

    // Build the "target" inventory from the same canned source the stubbed
    // npx will (deterministically) reproduce for the candidate.
    execFileSync(hermesc.path, ["-O", "-emit-binary", `-out=${targetHbcPath}`, "-"], { input: CANNED_SOURCE });
    const target = buildInventory(readFileSync(targetHbcPath)).inventory;
    assert.equal(target.modules.length, 3, "sanity: the canned source's own __d() registrations were recovered");

    // Three raw per-module guesses for the *same* package (as real guesses
    // for a package with several unattributed modules would look), one
    // deliberately versionless (the common case — a NativeModules.X hit
    // never carries a version) to exercise "nearest by date" resolution too.
    const candidates: ConfirmCandidate[] = [
      { package: "some-fake-pkg", version: null },
      { package: "some-fake-pkg", version: null },
      { package: "some-fake-pkg", version: "9.9.9" },
    ];

    const results = await confirmCandidates(candidates, target, {
      scratchProjectDir,
      rnVersion: "0.0.0-test",
      hbcVersion: 94,
      hermescPath: hermesc.path,
      projectDbDir,
      userCacheDbDir,
      rateLimitMs: 0,
      // `confirmCandidates` always resolves a default reference date off
      // `react-native`'s own publish date first — allow only that lookup;
      // the deduped candidate itself already carries a version, so nothing
      // else should ever call this.
      fetchVersionTimes: async (pkg) => {
        if (pkg === "react-native") return { "0.0.0-test": "2026-08-26T00:00:00.000Z" };
        throw new Error(`must not be called for ${pkg} — the deduped candidate already carries a version`);
      },
    });

    assert.equal(results.length, 1, "the three per-module guesses for one package dedupe to a single confirm attempt");
    const [result] = results;
    assert.equal(result!.ok, true, `expected a successful confirm, got: ${JSON.stringify(result)}`);
    const success = result as ConfirmSuccess;
    assert.equal(success.candidate.package, "some-fake-pkg");
    assert.equal(success.candidate.version, "9.9.9");
    assert.equal(success.score.tier, "high");
    assert.equal(success.writtenTo.length, 2, "written to both the project-local DB and the user cache");

    // D17b layering: a *stale* shared-DB copy of the same package@version
    // must never shadow the just-confirmed project-local one.
    const stale: SigDbFile = {
      schema: 2,
      package: "some-fake-pkg",
      version: "9.9.9",
      hbcVersion: 94,
      totalFunctions: 999,
      rawFunctionCount: 999,
      subtractedBaselines: [],
      functions: [],
      modules: [],
      toolchainBaseline: false,
      provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: 94, hermescRnEra: null, repoCommit: null, builtAt: new Date().toISOString() },
    };
    writeSignature(staleSharedDbDir, stale);

    const loaded = loadSignatures([
      { name: "project", dir: projectDbDir },
      { name: "user", dir: userCacheDbDir },
      { name: "shared", dir: staleSharedDbDir },
    ]);
    assert.equal(loaded.length, 1, "deduped to one entry across all three layers");
    assert.equal(loaded[0]!.layer, "project", "the project-local (just-confirmed) copy wins over the stale shared one");
    // 5, not 3: `fingerprintModule` hashes every function in the compiled
    // file, not just `__d()` factories — the global-scope function itself
    // (index 0) and the `__d` helper declaration are two more.
    assert.equal(loaded[0]!.file.totalFunctions, 5, "the real, just-fingerprinted signature — not the stale shared placeholder");
  } finally {
    process.env.PATH = originalPath;
    delete process.env.HBC2JS_TEST_FAKE_PKG_DIR;
    delete process.env.HBC2JS_TEST_FAKE_BUNDLE_JS;
    rmSync(work, { recursive: true, force: true });
  }
});

test("confirmCandidates: a candidate with no version evidence and a failed registry lookup fails without ever shelling out to npm", async () => {
  const work = tmpDir("hbc2js-confirm-noversion-");
  try {
    // Pre-seed react-native so `ensureScratchProject`'s own (unconditional,
    // per-run, unrelated-to-this-candidate) bootstrap install is a no-op —
    // this test is about `resolveCandidateVersion` failing before *this
    // candidate* ever touches `target`, `hermescPath`, or the network, not
    // about the scratch project's one-time setup.
    const scratchProjectDir = join(work, "scratch");
    mkdirSync(join(scratchProjectDir, "node_modules", "react-native"), { recursive: true });
    writeFileSync(join(scratchProjectDir, "node_modules", "react-native", "package.json"), JSON.stringify({ name: "react-native", version: "0.0.0" }));
    writeFileSync(join(scratchProjectDir, "metro.config.js"), "module.exports = {};");

    const emptyTarget: ModuleInventory = { hbcVersion: 94, totalFunctions: 0, moduledFunctionCount: 0, modules: [], functions: [] };
    const results = await confirmCandidates([{ package: "totally-made-up-pkg-xyz", version: null }], emptyTarget, {
      scratchProjectDir,
      rnVersion: "0.0.0",
      hbcVersion: 94,
      hermescPath: "/bin/false-nonexistent-hermesc",
      projectDbDir: join(work, "project-db"),
      userCacheDbDir: join(work, "user-cache-db"),
      rateLimitMs: 0,
      fetchVersionTimes: async () => null,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.ok, false);
    assert.equal(results[0]!.candidate.version, null);
    assert.match(results[0]!.reason!, /no version evidenced/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
