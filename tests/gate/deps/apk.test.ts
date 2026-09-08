// docs/DECISIONS.md D17a point (3)'s APK-side evidence, and the guard
// against Object.prototype pollution in its own lookup tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apkHintsFromEvidence, extractBundleFromApk, pickApkBundleCandidates } from "../../../src/deps/apk.ts";
import type { ApkEvidence } from "../../../src/deps/apk.ts";

function evidence(overrides: Partial<ApkEvidence>): ApkEvidence {
  return { packageName: null, permissions: [], nativeLibs: [], assetHints: [], usedAapt: false, notes: [], ...overrides };
}

test("apkHintsFromEvidence: BILLING permission hints at react-native-iap", () => {
  const hints = apkHintsFromEvidence(evidence({ permissions: ["com.android.vending.BILLING"] }));
  assert.equal(hints.get("react-native-iap"), "react-native-iap");
});

test("apkHintsFromEvidence: google-services.json asset hints at Firebase", () => {
  const hints = apkHintsFromEvidence(evidence({ assetHints: ["assets/google-services.json"] }));
  assert.equal(hints.get("assets/google-services.json"), "@react-native-firebase/app");
});

test("apkHintsFromEvidence: bundled reanimated .so hints at react-native-reanimated", () => {
  const hints = apkHintsFromEvidence(evidence({ nativeLibs: ["libreanimated.so"] }));
  assert.equal(hints.get("libreanimated.so"), "react-native-reanimated");
});

test("apkHintsFromEvidence: libhermes.so (the runtime itself) is never reported as a dependency", () => {
  const hints = apkHintsFromEvidence(evidence({ nativeLibs: ["libhermes.so"] }));
  assert.equal(hints.size, 0);
});

test("apkHintsFromEvidence: no evidence produces no hints", () => {
  const hints = apkHintsFromEvidence(evidence({}));
  assert.equal(hints.size, 0);
});

// Regression for docs/BUGS.md 2026-09-06 "bundle extraction ...
// CANDIDATE_ASSET_PATHS": bundle detection used to only try
// `assets/index.android.bundle` / `assets/index.bundle` exactly, missing
// custom-named Hermes bundles (com.oculus.twilight ships
// `assets/TwilightBundle.js.hbc`).
test("pickApkBundleCandidates: finds a custom-named assets/*.hbc entry with no conventional name present", () => {
  const candidates = pickApkBundleCandidates(["AndroidManifest.xml", "assets/TwilightBundle.js.hbc"]);
  assert.deepEqual(candidates, ["assets/TwilightBundle.js.hbc"]);
});

test("pickApkBundleCandidates: conventional name and custom .hbc are both listed, conventional first", () => {
  const candidates = pickApkBundleCandidates(["assets/index.android.bundle", "assets/TwilightBundle.js.hbc"]);
  assert.deepEqual(candidates, ["assets/index.android.bundle", "assets/TwilightBundle.js.hbc"]);
});

const HERMES_MAGIC_BYTES = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);

function haveZip(): boolean {
  return spawnSync("zip", ["-v"], { stdio: "ignore" }).status === 0 && spawnSync("unzip", ["-v"], { stdio: "ignore" }).status === 0;
}

// End-to-end: a real ZIP with a conventionally-named non-Hermes stub
// alongside a custom-named real Hermes bundle -- extractBundleFromApk must
// pick the one that actually starts with the Hermes magic header, not the
// one with the expected name (the exact com.oculus.twilight shape: a
// placeholder `assets/index.android.bundle` next to
// `assets/TwilightBundle.js.hbc`).
test("extractBundleFromApk: prefers a real Hermes bundle at a non-standard name over a conventionally-named stub", (t) => {
  if (!haveZip()) {
    t.skip("zip/unzip not on PATH");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-apk-bundle-pick-"));
  try {
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "index.android.bundle"), "not a real bundle, just a placeholder stub\n");
    writeFileSync(join(dir, "assets", "TwilightBundle.js.hbc"), Buffer.concat([HERMES_MAGIC_BYTES, Buffer.alloc(4), Buffer.from("fake hermes bytecode body for test purposes")]));
    const apkPath = join(dir, "test.apk");
    const zipResult = spawnSync("zip", ["-r", "-X", "test.apk", "assets"], { cwd: dir, encoding: "utf8" });
    assert.equal(zipResult.status, 0, zipResult.stderr);

    const result = extractBundleFromApk(apkPath);
    assert.equal(result.entryPath, "assets/TwilightBundle.js.hbc", "must pick the real Hermes bundle, not the stub with the conventional name");
    assert.equal(result.isHermes, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
