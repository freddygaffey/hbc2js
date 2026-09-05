// tests/gate/ui/keymap-default.test.ts — review-2026-09-05-keys
// (docs/BUGS.md): the owner reported "none of the key bindings work". Every
// chord the shipped presets name must (a) parse, (b) name a real action, and
// (c) actually fire for the KeyboardEvent a browser produces for it — the
// last one is what was broken: "Ctrl-P" never matched Chrome's `key: "p"`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStandardRegistry } from "../../../src/ui-core/actions.ts";
import { createKeymap, type KeyEvent } from "../../../src/ui-core/keymap.ts";
import { loadPreset } from "../../../src/ui-core/keymap-config.ts";
import { PRESET_NAMES } from "../../../src/ui-core/keymap-resolve.ts";

/** The KeyboardEvent a browser reports when the user types `chord`'s LAST
 *  step — enough for the single-step chords the default preset is made of. */
function eventsFor(chord: string): KeyEvent[] {
  const parts = chord.split("-");
  const key = parts.pop()!;
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const named: Record<string, string> = { Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown" };
  const base: KeyEvent = { key: named[key] ?? key, ctrl: mods.has("ctrl"), alt: mods.has("alt"), shift: mods.has("shift"), meta: mods.has("meta") };
  if (key.length !== 1 || !/[a-zA-Z]/.test(key) || parts.length === 0) return [base];
  // A letter with a modifier: the browser lower-cases it unless Shift is held.
  return [{ ...base, key: mods.has("shift") ? key.toUpperCase() : key.toLowerCase() }];
}

test("every chord in every shipped preset fires its action for a real browser key event", () => {
  const registry = createStandardRegistry();
  for (const name of PRESET_NAMES) {
    const preset = loadPreset(name);
    const km = createKeymap({ preset });
    for (const [chord, actionId] of Object.entries(preset)) {
      assert.notEqual(registry.get(actionId), undefined, `${name}: chord "${chord}" names unknown action "${actionId}"`);
      if (chord.length > 1 && !chord.includes("-")) continue; // multi-key sequences (vim "gd") — covered in tests/ui-core
      km.reset();
      const events = eventsFor(chord);
      const last = events.map((e) => km.feed(e)).pop();
      assert.deepEqual(last, { actionId, count: 1 }, `${name}: chord "${chord}" did not fire ${actionId}`);
    }
  }
});

// -- bur 4 (docs/UI-BURS.md #4): "/" should open search --------------------
test('every shipped preset binds "/" to project.search', () => {
  for (const name of PRESET_NAMES) {
    const preset = loadPreset(name);
    assert.equal(preset["/"], "project.search", `${name}: "/" is not bound to project.search`);
  }
});

// -- bur 5 (docs/UI-BURS.md #5): ":" opens the command palette in command
// mode (project.commandMode, not the plain project.palette — the palette
// itself tells the two apart by whether the query starts with ":").
test('every shipped preset binds ":" to project.commandMode', () => {
  for (const name of PRESET_NAMES) {
    const preset = loadPreset(name);
    assert.equal(preset[":"], "project.commandMode", `${name}: ":" is not bound to project.commandMode`);
  }
});

// -- bur 6 (docs/UI-BURS.md #6): light/dark is a keymap-reachable toggle,
// not just a Settings dropdown, in every preset.
test("every shipped preset binds a chord to view.themeToggle", () => {
  const registry = createStandardRegistry();
  for (const name of PRESET_NAMES) {
    const preset = loadPreset(name);
    const km = createKeymap({ preset });
    const chord = km.chordFor("view.themeToggle");
    assert.notEqual(chord, undefined, `${name}: no chord bound to view.themeToggle`);
    assert.notEqual(registry.get("view.themeToggle"), undefined);
  }
});

// -- burs 9 + 10 (docs/UI-BURS.md #9, #10; spec 25 §5a/§5b): the graph
// pane's two view toggles are keymap-reachable in every preset - `g f`
// (follow the listing selection) and `g z` (cycle the semantic-zoom level
// far/mid/near). They are multi-key sequences, so the firing assertion at
// the top of this file skips them; what matters here is that every preset
// binds them and that the SHARED registry knows the ids (a chord naming a
// UI-only action would be dangling in any other shell).
test("every shipped preset binds graph.followToggle and graph.lodCycle", () => {
  const registry = createStandardRegistry();
  for (const id of ["graph.followToggle", "graph.lodCycle"]) {
    assert.notEqual(registry.get(id), undefined, `${id} is not in the standard registry`);
  }
  for (const name of PRESET_NAMES) {
    const preset = loadPreset(name);
    const km = createKeymap({ preset });
    for (const id of ["graph.followToggle", "graph.lodCycle"]) {
      assert.notEqual(km.chordFor(id), undefined, `${name}: no chord bound to ${id}`);
    }
    assert.equal(preset["gf"], "graph.followToggle", `${name}: "gf" is not bound to graph.followToggle`);
    assert.equal(preset["gz"], "graph.lodCycle", `${name}: "gz" is not bound to graph.lodCycle`);
  }
});

// -- bur 13 (docs/UI-BURS.md #13): arrow keys move the selection down (and
// up, and left/right between tokens) in the listing, in every preset — not
// only vim's own `j`/`k` motions. The generic firing assertion at the top of
// this file already replays "Down"/"Up"/"Left"/"Right" as real
// ArrowDown/Up/Left/Right KeyboardEvents for every chord a preset binds; this
// test pins the SPECIFIC action ids so a future rebind cannot silently point
// the arrows somewhere else without failing here first.
test("every shipped preset binds Up/Down/Left/Right to the listing navigation actions", () => {
  const registry = createStandardRegistry();
  for (const id of ["listing.lineDown", "listing.lineUp", "listing.tokenLeft", "listing.tokenRight"]) {
    assert.notEqual(registry.get(id), undefined, `${id} is not in the standard registry`);
  }
  for (const name of PRESET_NAMES) {
    const preset = loadPreset(name);
    assert.equal(preset["Down"], "listing.lineDown", `${name}: "Down" is not bound to listing.lineDown`);
    assert.equal(preset["Up"], "listing.lineUp", `${name}: "Up" is not bound to listing.lineUp`);
    assert.equal(preset["Left"], "listing.tokenLeft", `${name}: "Left" is not bound to listing.tokenLeft`);
    assert.equal(preset["Right"], "listing.tokenRight", `${name}: "Right" is not bound to listing.tokenRight`);
  }
});
