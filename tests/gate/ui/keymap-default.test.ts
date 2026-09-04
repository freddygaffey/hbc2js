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
