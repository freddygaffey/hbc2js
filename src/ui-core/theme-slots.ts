// src/ui-core/theme-slots.ts — pure logic for the two-slot light/dark theme
// toggle (docs/UI-BURS.md #12): the theme store keeps exactly one preset
// assigned to each of "light"/"dark", plus which slot is currently active.
// The toolbar button and `view.themeToggle` flip the active slot only;
// Settings assigns each slot a preset from the presets of that mode only —
// the full preset list is never shown in one menu again (that was bur 12's
// complaint about bur 6's family dropdown).
//
// Kept dependency-free (no DOM, no `import.meta.glob`) so it is unit
// testable under plain `node --test`, the same split as
// `keymap-resolve.ts`/`keymap.ts` (pure resolution) vs. `ui/src/theme/store.ts`
// (the persisted, applied, React-visible wrapper).
export type ThemeMode = "light" | "dark";

export interface ThemeSlots {
  readonly light: string;
  readonly dark: string;
  readonly mode: ThemeMode;
}

/** Looks up a preset's mode by name; `undefined` when the name is unknown.
 *  Implemented by `ui/src/theme/apply.ts` in the real app, and by a plain
 *  object in tests. */
export interface PresetLookup {
  modeOf(name: string): ThemeMode | undefined;
}

export function otherMode(mode: ThemeMode): ThemeMode {
  return mode === "light" ? "dark" : "light";
}

/** The preset actually on screen: whichever slot the active mode names. */
export function activePreset(slots: ThemeSlots): string {
  return slots[slots.mode];
}

/** Assigns `name` to `mode`'s slot. Throws (leaving `slots` conceptually
 *  unchanged — callers must not commit the result) when `name` is not a
 *  known preset, or names a preset of the OTHER mode: a light theme can
 *  never sit in the dark slot, so Settings' two selects only ever offer
 *  presets of the matching mode and this is the belt-and-braces check. Does
 *  not change which slot is active. */
export function withSlot(slots: ThemeSlots, mode: ThemeMode, name: string, lookup: PresetLookup): ThemeSlots {
  const presetMode = lookup.modeOf(name);
  if (presetMode === undefined) throw new Error(`unknown theme preset "${name}"`);
  if (presetMode !== mode) throw new Error(`preset "${name}" is a ${presetMode} theme, not ${mode}`);
  return { ...slots, [mode]: name };
}

/** Assigns `name` to whichever slot matches ITS OWN mode, and switches the
 *  active mode to match it. This is what `:set theme <preset>` (bur 5) uses
 *  so naming any preset directly by name still both configures a slot and
 *  makes it visible immediately, exactly as before this bur. */
export function withPresetActive(slots: ThemeSlots, name: string, lookup: PresetLookup): ThemeSlots {
  const presetMode = lookup.modeOf(name);
  if (presetMode === undefined) throw new Error(`unknown theme preset "${name}"`);
  return { ...slots, [presetMode]: name, mode: presetMode };
}

/** Flips to the other slot — bur 12's toolbar button, `view.themeToggle`,
 *  and the command palette's "Toggle theme" row all call this. */
export function toggled(slots: ThemeSlots): ThemeSlots {
  return { ...slots, mode: otherMode(slots.mode) };
}
