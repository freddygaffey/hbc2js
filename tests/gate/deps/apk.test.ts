// docs/DECISIONS.md D17a point (3)'s APK-side evidence, and the guard
// against Object.prototype pollution in its own lookup tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { apkHintsFromEvidence } from "../../../src/deps/apk.ts";
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
