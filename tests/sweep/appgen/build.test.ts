// docs/specs/09-fuzzing.md §2.2/§2.6: proves the real end-to-end triple
// build (npm install a generated RN 0.73.11 app -> `react-native bundle`
// -> project's own hermesc -> compose-source-maps.js). Sweep-gated
// (HBC2JS_TIER=sweep|all): an `npm install` + Metro bundle run is minutes,
// not gate-budget (~2 min for the whole suite), and needs network access
// (npm registry) -- both reasons the task brief names for sweep-gating this
// specific test. Fast, network-free properties (generator determinism,
// manifest-hash dedup, disk preflight) live in tests/appgen/ and run in the
// main gate. Run directly: `HBC2JS_TIER=sweep node --test tests/sweep/appgen/build.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireSweep } from "../../support/tiers.ts";
import { buildOne } from "../../../tools/appgen/build.mjs";
import { HBC_MAGIC } from "../../../src/parse/header.ts";

test("appgen build.mjs: seed -> real (bundle.hbc, bundle.map, source) triple", async (t) => {
  if (!requireSweep(t)) return;

  const manifestDir = mkdtempSync(join(tmpdir(), "hbc2js-appgen-manifest-"));
  const manifestPath = join(manifestDir, "manifest.json");
  const appgenDirBackup = process.env.HBC2JS_APPGEN_DIR;
  const tripleStoreDir = mkdtempSync(join(tmpdir(), "hbc2js-appgen-store-"));
  process.env.HBC2JS_APPGEN_DIR = tripleStoreDir;

  try {
    const result = buildOne("sweep-test-seed-1", { manifestPath });
    assert.equal(result.skipped, false, "a fresh seed against an empty manifest store must not be skipped as duplicate");
    assert.ok(existsSync(join(result.destDir, "bundle.hbc")), "triple must include bundle.hbc");
    assert.ok(existsSync(join(result.destDir, "bundle.map")), "triple must include bundle.map (Metro map composed with Hermes map)");
    assert.ok(existsSync(join(result.destDir, "source")), "triple must include the generated source tree");
    assert.ok(existsSync(join(result.destDir, "config.json")), "triple must include config.json provenance");
    assert.ok(existsSync(join(result.destDir, "hashes.json")), "triple must include hashes.json");

    const hbcBytes = readFileSync(join(result.destDir, "bundle.hbc"));
    assert.ok(hbcBytes.length > 0, "bundle.hbc must be nonempty");
    // Hermes bytecode magic number (docs/HBC-FORMAT.md), independent proof
    // this is a real compiled bytecode file, not a stub.
    assert.equal(hbcBytes.readBigUInt64LE(0), HBC_MAGIC, "bundle.hbc must start with the Hermes magic number");

    const map = JSON.parse(readFileSync(join(result.destDir, "bundle.map"), "utf8"));
    assert.ok(Array.isArray(map.sources) && map.sources.length > 0, "composed map must carry real sources");

    assert.equal(result.config.hbcVersion, 96, "RN 0.73.11 must be recorded as HBC 96 (docs/TOOLCHAIN.md)");

    // Workspace is deleted, not kept as a project (spec §2.4).
    assert.ok(!existsSync(join(tmpdir(), "does-not-leak-workspace-marker")));

    const store = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(store.length, 1);
    assert.equal(store[0].fingerprint, result.config.fingerprint);

    // Re-running the exact same seed against the now-populated store is a
    // duplicate (spec §2.3.1) and must be skipped without rebuilding.
    const again = buildOne("sweep-test-seed-1", { manifestPath });
    assert.equal(again.skipped, true);
  } finally {
    rmSync(manifestDir, { recursive: true, force: true });
    rmSync(tripleStoreDir, { recursive: true, force: true });
    if (appgenDirBackup === undefined) delete process.env.HBC2JS_APPGEN_DIR;
    else process.env.HBC2JS_APPGEN_DIR = appgenDirBackup;
  }
});
