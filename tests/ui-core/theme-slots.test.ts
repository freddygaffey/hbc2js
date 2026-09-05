// tests/ui-core/theme-slots.test.ts — docs/UI-BURS.md #12: the two-slot
// light/dark theme toggle's pure logic (src/ui-core/theme-slots.ts). The
// DOM-facing wrapper (ui/src/theme/store.ts) is exercised by
// ui/e2e/theme.spec.ts instead, since it needs a browser + localStorage.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activePreset, otherMode, toggled, withPresetActive, withSlot, type PresetLookup, type ThemeMode, type ThemeSlots,
} from "../../src/ui-core/theme-slots.ts";

// A tiny fake preset table: "day"/"day2" are light, "night"/"night2" dark.
const MODES: Record<string, ThemeMode> = { day: "light", day2: "light", night: "dark", night2: "dark" };
const lookup: PresetLookup = { modeOf: (name) => MODES[name] };

function slots(light: string, dark: string, mode: ThemeMode): ThemeSlots {
  return { light, dark, mode };
}

test("otherMode flips light/dark", () => {
  assert.equal(otherMode("light"), "dark");
  assert.equal(otherMode("dark"), "light");
});

test("activePreset returns the slot matching the active mode", () => {
  assert.equal(activePreset(slots("day", "night", "light")), "day");
  assert.equal(activePreset(slots("day", "night", "dark")), "night");
});

test("toggled flips the active mode only, leaving both slots untouched", () => {
  const s = slots("day", "night", "light");
  const t = toggled(s);
  assert.equal(t.mode, "dark");
  assert.equal(t.light, "day");
  assert.equal(t.dark, "night");
  assert.equal(activePreset(t), "night");
});

test("withSlot assigns a same-mode preset to that slot, without changing the active mode", () => {
  const s = slots("day", "night", "light");
  const t = withSlot(s, "light", "day2", lookup);
  assert.equal(t.light, "day2");
  assert.equal(t.dark, "night");
  assert.equal(t.mode, "light");
});

test("withSlot rejects a preset of the wrong mode", () => {
  const s = slots("day", "night", "light");
  assert.throws(() => withSlot(s, "light", "night2", lookup), /is a dark theme, not light/);
  assert.throws(() => withSlot(s, "dark", "day2", lookup), /is a light theme, not dark/);
});

test("withSlot rejects an unknown preset name", () => {
  const s = slots("day", "night", "light");
  assert.throws(() => withSlot(s, "light", "nope", lookup), /unknown theme preset "nope"/);
});

test("withPresetActive fills the preset's own slot and makes it active (`:set theme <preset>`)", () => {
  const s = slots("day", "night", "light");
  const t = withPresetActive(s, "night2", lookup);
  assert.equal(t.dark, "night2");
  assert.equal(t.light, "day");
  assert.equal(t.mode, "dark");
  assert.equal(activePreset(t), "night2");
});

test("withPresetActive rejects an unknown preset name", () => {
  const s = slots("day", "night", "light");
  assert.throws(() => withPresetActive(s, "nope", lookup), /unknown theme preset "nope"/);
});
