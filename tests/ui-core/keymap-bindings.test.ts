// tests/ui-core/keymap-bindings.test.ts — review-2026-09-05-keys
// (docs/BUGS.md): the chord/event normalisation that made the whole default
// keymap dead, plus the pure layering the in-app key-binding editor
// (ui/src/components/SettingsDialog.tsx) drives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeymap, formatChord } from "../../src/ui-core/keymap.ts";
import {
  chordConflicts, chordsByAction, mergeBindings, rebind, resetAction, unbindAction,
} from "../../src/ui-core/keymap-resolve.ts";

const PRESET = { "Ctrl-P": "project.palette", "Ctrl-F": "project.search", "Ctrl-Shift-N": "annotate.finding", "?": "project.shortcuts", "gd": "navigate.definition" };

test("a modified letter chord matches the key the browser actually reports (Ctrl-P vs key 'p')", () => {
  const km = createKeymap({ preset: PRESET });
  // This is the bug: Chrome reports `key: "p"` for Ctrl+P, the chord string
  // writes "P", and the two used to hash to different trie keys.
  assert.deepEqual(km.feed({ key: "p", ctrl: true }), { actionId: "project.palette", count: 1 });
  km.reset();
  assert.deepEqual(km.feed({ key: "P", ctrl: true }), { actionId: "project.palette", count: 1 });
  km.reset();
  assert.deepEqual(km.feed({ key: "f", ctrl: true }), { actionId: "project.search", count: 1 });
});

test("Shift is still significant for a modified letter, and ignored for punctuation", () => {
  const km = createKeymap({ preset: { "Ctrl-N": "navigate.nextFn", "Ctrl-Shift-N": "annotate.finding", "Ctrl-/": "annotate.comment" } });
  assert.deepEqual(km.feed({ key: "n", ctrl: true }), { actionId: "navigate.nextFn", count: 1 });
  km.reset();
  assert.deepEqual(km.feed({ key: "N", ctrl: true, shift: true }), { actionId: "annotate.finding", count: 1 });
  km.reset();
  // "/" needs Shift on some layouts and not on others — never a mismatch.
  assert.deepEqual(km.feed({ key: "/", ctrl: true, shift: true }), { actionId: "annotate.comment", count: 1 });
});

test("a bare character step stays case-significant (vim K is not k)", () => {
  const km = createKeymap({ preset: { K: "ai.explain" } });
  assert.equal(km.feed({ key: "k" }), "none");
  assert.deepEqual(km.feed({ key: "K", shift: true }), { actionId: "ai.explain", count: 1 });
});

test("formatChord round-trips through the keymap for every shape the recorder can capture", () => {
  const cases: { ev: Parameters<ReturnType<typeof createKeymap>["feed"]>[0]; chord: string }[] = [
    { ev: { key: "p", ctrl: true }, chord: "Ctrl-P" },
    { ev: { key: "N", ctrl: true, shift: true }, chord: "Ctrl-Shift-N" },
    { ev: { key: "?" }, chord: "?" },
    { ev: { key: "F12" }, chord: "F12" },
    { ev: { key: "ArrowLeft", alt: true }, chord: "Alt-Left" },
  ];
  for (const { ev, chord } of cases) {
    assert.equal(formatChord(ev), chord, `formatChord(${JSON.stringify(ev)})`);
    const km = createKeymap({ preset: { [chord]: "x" } });
    assert.deepEqual(km.feed(ev), { actionId: "x", count: 1 }, `feed after formatChord ${chord}`);
  }
  assert.equal(formatChord({ key: "Shift", shift: true }), undefined);
});

test("mergeBindings layers overrides on the preset and null unbinds", () => {
  const merged = mergeBindings(PRESET, { "Ctrl-P": null, "Ctrl-O": "project.palette" });
  assert.equal(merged["Ctrl-P"], undefined);
  assert.equal(merged["Ctrl-O"], "project.palette");
  assert.deepEqual(chordsByAction(merged)["project.palette"], ["Ctrl-O"]);
});

test("chordConflicts reports same/prefix/extension and ignores the action's own chord", () => {
  assert.deepEqual(chordConflicts(PRESET, "Ctrl-P", "annotate.rename"), [
    { chord: "Ctrl-P", actionId: "project.palette", kind: "same" },
  ]);
  assert.deepEqual(chordConflicts(PRESET, "Ctrl-P", "project.palette"), []);
  assert.deepEqual(chordConflicts(PRESET, "gdx", "x"), [{ chord: "gd", actionId: "navigate.definition", kind: "prefix" }]);
  assert.deepEqual(chordConflicts(PRESET, "g", "x"), [{ chord: "gd", actionId: "navigate.definition", kind: "extension" }]);
});

test("rebind replaces: the action moves, its old chord is released, the clashing one is unbound", () => {
  const next = rebind(PRESET, {}, "annotate.finding", "Ctrl-P", "replace");
  const merged = mergeBindings(PRESET, next);
  assert.equal(merged["Ctrl-P"], "annotate.finding");
  assert.equal(merged["Ctrl-Shift-N"], undefined, "the action's previous chord is released");
  assert.equal(chordsByAction(merged)["project.palette"], undefined, "the clashing action loses the chord");
});

test("rebind swaps: the clashing action inherits this action's previous chord", () => {
  const merged = mergeBindings(PRESET, rebind(PRESET, {}, "annotate.finding", "Ctrl-P", "swap"));
  assert.equal(merged["Ctrl-P"], "annotate.finding");
  assert.equal(merged["Ctrl-Shift-N"], "project.palette");
});

test("unbindAction leaves the action with no chord; resetAction puts the preset back", () => {
  const unbound = unbindAction(PRESET, {}, "project.palette");
  assert.equal(mergeBindings(PRESET, unbound)["Ctrl-P"], undefined);
  const back = resetAction(PRESET, unbound, "project.palette");
  assert.equal(mergeBindings(PRESET, back)["Ctrl-P"], "project.palette");
  // A user-added chord for the action is dropped by reset too.
  const moved = rebind(PRESET, {}, "project.palette", "Ctrl-O");
  assert.equal(mergeBindings(PRESET, resetAction(PRESET, moved, "project.palette"))["Ctrl-P"], "project.palette");
});

test("the default preset resolves against a live keymap for every chord it names", () => {
  const km = createKeymap({ preset: PRESET });
  for (const [chord, id] of Object.entries(PRESET)) assert.equal(typeof km.chordFor(id), "string", `${chord} -> ${id}`);
});
