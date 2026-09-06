// Regression test for docs/BUGS.md 2026-09-06 "bundle extraction ...
// CANDIDATE_ASSET_PATHS": bundle detection in tools/e2e/corpus-regression.mjs
// used to only match 4 exact asset names, missing custom-named Hermes
// bundles like com.oculus.twilight's `assets/TwilightBundle.js.hbc`. Tests
// the pure candidate-list builder directly (no real corpus/APK needed) plus
// the "0 modules must never be silent ok" overfit flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickBundleCandidates, detectOverfitFlags } from "../../../tools/e2e/corpus-regression.mjs";

test("pickBundleCandidates: finds a custom-named assets/*.hbc bundle even with no conventional-name entry present", () => {
  const entries = ["AndroidManifest.xml", "classes.dex", "assets/TwilightBundle.js.hbc", "assets/fonts/Foo.ttf"];
  const candidates = pickBundleCandidates(entries);
  assert.deepEqual(candidates, ["assets/TwilightBundle.js.hbc"]);
});

test("pickBundleCandidates: a conventional stub AND a custom-named .hbc are both surfaced (caller picks by content)", () => {
  const entries = ["assets/index.android.bundle", "assets/TwilightBundle.js.hbc"];
  const candidates = pickBundleCandidates(entries);
  assert.deepEqual(candidates, ["assets/index.android.bundle", "assets/TwilightBundle.js.hbc"], "both candidates must be listed so the magic-header check can prefer the real one");
});

test("pickBundleCandidates: no bundle-shaped entry at all returns an empty list", () => {
  assert.deepEqual(pickBundleCandidates(["AndroidManifest.xml", "classes.dex"]), []);
});

test("detectOverfitFlags: a decompile with 0 modules is flagged, never silently 'ok'", () => {
  const flags = detectOverfitFlags(
    {
      decompile: { status: "ok" },
      totalModules: 0,
      validJsPct: 0,
      screens: { detected: 0, plausibilityRatio: 1 },
      navigators: { detected: 0 },
      varNaming: { pct: 0, totalRegisters: 0 },
    },
    null,
  );
  assert.ok(
    flags.some((f: string) => /0 modules/.test(f)),
    `expected a "0 modules" flag, got: ${JSON.stringify(flags)}`,
  );
});

test("detectOverfitFlags: a decompile with modules and full validity gets no 0-modules flag", () => {
  const flags = detectOverfitFlags(
    {
      decompile: { status: "ok" },
      totalModules: 12,
      validJsPct: 100,
      screens: { detected: 0, plausibilityRatio: 1 },
      navigators: { detected: 0 },
      varNaming: { pct: 100, totalRegisters: 10 },
    },
    null,
  );
  assert.ok(!flags.some((f: string) => /0 modules/.test(f)));
});
