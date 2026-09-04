// docs/reports/2026-09-05-campaign2-v96-vm-rediff.md — regression test for
// the "harness stop hiding this" fix (brief step 4): a traced version's cell
// must not claim `mode: "full-ladder"` unless the reference engine actually
// used was `hermes-vm`. Cheap: `tools/fuzz/reference-mode.mjs` is pure
// (stubbed `ReferenceChoice`-shaped inputs below), so this needs no VM and
// no hermesc — it never imports construct-fuzz.mjs/reclassify-finds.mjs
// themselves, since both run their whole `main()` unconditionally on import.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — .mjs tool module, no type declarations by design.
import { modeForCell, referenceEngineBanner } from "../../../tools/fuzz/reference-mode.mjs";
import { chooseReference } from "../../../src/harness/reference-policy.ts";

test("modeForCell: traced version + hermes-vm engine -> full-ladder", () => {
  assert.equal(modeForCell(true, "hermes-vm"), "full-ladder");
});

test("modeForCell: traced version + expected-txt engine -> full-ladder-no-vm, never full-ladder", () => {
  assert.equal(modeForCell(true, "expected-txt"), "full-ladder-no-vm");
});

test("modeForCell: traced version + node-source engine -> full-ladder-no-vm", () => {
  assert.equal(modeForCell(true, "node-source"), "full-ladder-no-vm");
});

test("modeForCell: untraced version stays roundtrip-only regardless of engine", () => {
  assert.equal(modeForCell(false, "hermes-vm"), "roundtrip-only");
  assert.equal(modeForCell(false, "expected-txt"), "roundtrip-only");
});

test("referenceEngineBanner: hermes-vm engine gets no '(no Hermes VM found)' suffix", () => {
  const line = referenceEngineBanner(94, { engine: "hermes-vm", reason: "Hermes VM v94 is available", knownDivergences: [] });
  assert.match(line, /^v94: reference engine = hermes-vm — Hermes VM v94 is available$/);
  assert.doesNotMatch(line, /no Hermes VM found/);
});

test("referenceEngineBanner: non-hermes-vm engine is flagged loudly, per-version", () => {
  const line = referenceEngineBanner(96, { engine: "expected-txt", reason: "no Hermes VM for v96; not a known-divergence construct", knownDivergences: [] });
  assert.match(line, /^v96: reference engine = expected-txt \(no Hermes VM found\) — /);
});

// Integration check with the real policy, on a version this repo never ships
// a VM for (98 — docs/TOOLCHAIN.md), so it's deterministic on every host:
// the same real ReferenceChoice `chooseReference` produces must classify as
// full-ladder-no-vm when treated as a (hypothetically) traced version, never
// full-ladder.
test("integration: real chooseReference for a no-VM version composes to full-ladder-no-vm", () => {
  const reference = chooseReference({ name: "99-does-not-exist-and-is-not-divergent" }, 98);
  assert.equal(reference.engine, "expected-txt");
  assert.equal(modeForCell(true, reference.engine), "full-ladder-no-vm");
  assert.match(referenceEngineBanner(98, reference), /no Hermes VM found/);
});
