// docs/specs/09-fuzzing.md §2.1's build-config axes, increment 2: real,
// network-and-npm-install-heavy proof for the three axes this increment
// adds on top of tests/sweep/appgen/build.test.ts's HBC-96/metro-plain/
// unobfuscated baseline. Sweep-gated for the same reasons as that file.
// Run directly: `HBC2JS_TIER=sweep node --test tests/sweep/appgen/build-axes.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireSweep } from "../../support/tiers.ts";
import { buildOne } from "../../../tools/appgen/build.mjs";
import { RN_PINS } from "../../../tools/appgen/lib/versions.mjs";
import type { RnPin } from "../../../tools/appgen/lib/versions.d.mts";
import { HBC_MAGIC } from "../../../src/parse/header.ts";

const HBC96: RnPin = RN_PINS[96]!;
const HBC98: RnPin = RN_PINS[98]!;

function withTempStore(fn: (manifestPath: string) => Promise<void> | void) {
  const manifestDir = mkdtempSync(join(tmpdir(), "hbc2js-appgen-manifest-"));
  const manifestPath = join(manifestDir, "manifest.json");
  const appgenDirBackup = process.env.HBC2JS_APPGEN_DIR;
  const tripleStoreDir = mkdtempSync(join(tmpdir(), "hbc2js-appgen-store-"));
  process.env.HBC2JS_APPGEN_DIR = tripleStoreDir;
  return Promise.resolve()
    .then(() => fn(manifestPath))
    .finally(() => {
      rmSync(manifestDir, { recursive: true, force: true });
      rmSync(tripleStoreDir, { recursive: true, force: true });
      if (appgenDirBackup === undefined) delete process.env.HBC2JS_APPGEN_DIR;
      else process.env.HBC2JS_APPGEN_DIR = appgenDirBackup;
    });
}

test("appgen build.mjs: version rotation — RN 0.86.0 pin builds a real HBC 98 triple (spec §2.1)", async (t) => {
  if (!requireSweep(t)) return;
  await withTempStore((manifestPath) => {
    const result = buildOne("sweep-axes-hbc98", { manifestPath, rnPin: HBC98 });
    assert.equal(result.skipped, false);
    assert.equal(result.config.hbcVersion, 98);
    assert.equal(result.config.buildStatus, "ok");
    const hbcBytes = readFileSync(join(result.destDir, "bundle.hbc"));
    assert.equal(hbcBytes.readBigUInt64LE(0), HBC_MAGIC, "bundle.hbc must be real Hermes bytecode");
  });
});

test("appgen build.mjs: Metro RAM bundle axis — current RN CLI rejects --indexed-ram-bundle (finding, docs/BUGS.md)", async (t) => {
  if (!requireSweep(t)) return;
  await withTempStore((manifestPath) => {
    const result = buildOne("sweep-axes-ram", { manifestPath, rnPin: HBC96, bundler: "metro-ram" });
    assert.equal(result.skipped, false);
    // The build is recorded (stored, not a crash) even though it fails --
    // spec §2.1's "the triple still gets stored for when it can be
    // consumed" via this pipeline's provenance-carrying failure path.
    assert.equal(result.config.buildStatus, "failed");
    assert.match(result.config.buildError ?? "", /indexed-ram-bundle/);
    assert.ok(!existsSync(join(result.destDir, "bundle.hbc")), "no valid bundle.hbc can exist for a rejected bundler flag");
  });
});

test("appgen build.mjs: obfuscation axis — Metro --minify true produces a real HBC 96 triple (spec §2.1)", async (t) => {
  if (!requireSweep(t)) return;
  await withTempStore((manifestPath) => {
    const result = buildOne("sweep-axes-obfuscate", { manifestPath, rnPin: HBC96, obfuscate: true });
    assert.equal(result.skipped, false);
    assert.equal(result.config.obfuscation, "metro-minify");
    assert.equal(result.config.buildStatus, "ok");
    const hbcBytes = readFileSync(join(result.destDir, "bundle.hbc"));
    assert.equal(hbcBytes.readBigUInt64LE(0), HBC_MAGIC, "bundle.hbc must be real Hermes bytecode");
  });
});
