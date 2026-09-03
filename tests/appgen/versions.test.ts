// docs/specs/09-fuzzing.md §2.1 "RN + Hermes version" axis: the RN-pin
// table and its hermesc-path-by-distribution-mechanism logic
// (tools/appgen/lib/versions.mjs), gate-fast (no npm install, no network).
// Real-build proof lives at sweep tier (tests/sweep/appgen/build-axes.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { RN_PINS, DEFAULT_RN_PIN, hermescPathForRn } from "../../tools/appgen/lib/versions.mjs";

test("versions: RN_PINS covers HBC 96 and 98, keyed by hbcVersion", () => {
  const p96 = RN_PINS[96];
  const p98 = RN_PINS[98];
  assert.ok(p96 && p98);
  assert.equal(p96.rnVersion, "0.73.11");
  assert.equal(p96.hbcVersion, 96);
  assert.equal(p98.rnVersion, "0.86.0");
  assert.equal(p98.hbcVersion, 98);
  assert.ok(p98.directHermescFallback, "v98 pin must record the spec §2.1 fallback provenance path");
});

test("versions: v84 is out of scope (spec §2.1: legacy)", () => {
  assert.equal(RN_PINS[84], undefined);
});

test("versions: DEFAULT_RN_PIN is the HBC 96 pin (increment-1 default, backward compatible)", () => {
  assert.deepEqual(DEFAULT_RN_PIN, RN_PINS[96]);
});

test("hermescPathForRn: RN <= 0.82 resolves under react-native/sdks/hermesc (old mechanism)", () => {
  const path = hermescPathForRn("0.73.11")("/ws", "osx-bin");
  assert.equal(path, "/ws/node_modules/react-native/sdks/hermesc/osx-bin/hermesc");
});

test("hermescPathForRn: RN >= 0.83 resolves under node_modules/hermes-compiler (new mechanism, spec §2.1)", () => {
  const path = hermescPathForRn("0.86.0")("/ws", "linux64-bin");
  assert.equal(path, "/ws/node_modules/hermes-compiler/hermesc/linux64-bin/hermesc");
});
