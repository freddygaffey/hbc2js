// src/ui-core/keymap-resolve.ts — the pure half of keymap-config.ts
// (docs/specs/22-ui-mvp.md §3.2). `keymap-config.ts` reads the preset files
// off disk with `node:fs`, which a browser bundle cannot even *import* (the
// ui/ package has no node types and no fs); the browser shell imports the
// same `presets/*.json` through Vite and calls this instead, so preset
// resolution and override validation exist exactly once for both callers.
import type { Registry } from "./actions.ts";
import { chordStepKeys, type CreateKeymapOptions } from "./keymap.ts";

export const PRESET_NAMES = ["default", "vim", "ghidra"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

/** The `ui/keymap.json` shape: which preset, plus chord -> action id
 *  overrides (`null` unbinds a preset chord). */
export interface KeymapConfig {
  preset: string;
  overrides?: Record<string, string | null>;
}

export type PresetTable = Readonly<Record<string, Record<string, string>>>;

/**
 * Validates `config` against `presets` and `registry` and returns
 * `createKeymap` options. Throws, naming the valid presets, on an unknown
 * preset name; throws, listing the valid ids, when an override names an
 * action id the registry does not have (a dangling binding is a typo, not
 * a silently-dead key).
 */
export function resolveKeymapConfigWith(config: KeymapConfig, registry: Registry, presets: PresetTable): CreateKeymapOptions {
  const preset = presets[config.preset];
  if (preset === undefined) {
    throw new Error(`ui-core/keymap-config: unknown preset "${config.preset}" (valid presets: ${PRESET_NAMES.join(", ")})`);
  }
  const overrides = config.overrides ?? {};
  const validIds = registry.list().map((a) => a.id);
  for (const [chord, actionId] of Object.entries(overrides)) {
    if (actionId !== null && registry.get(actionId) === undefined) {
      throw new Error(
        `ui-core/keymap-config: override for chord "${chord}" names unknown action id "${actionId}" (valid ids: ${validIds.join(", ")})`,
      );
    }
  }
  return { preset, overrides };
}

// -- binding layering, for the in-app key-binding editor ---------------------
//
// The Settings dialog edits the SAME `overrides` map `ui/keymap.json` has, so
// there is exactly one layering rule and one resolver. These helpers are the
// pure part the dialog needs before it can hand a config to
// `resolveKeymapConfigWith`: what the merged table looks like, and whether a
// proposed chord would make `createKeymap` throw.

/** preset + overrides, flattened (`null` unbinds), chord -> action id. */
export function mergeBindings(preset: Record<string, string>, overrides: Record<string, string | null> = {}): Record<string, string> {
  const out: Record<string, string> = { ...preset };
  for (const [chord, actionId] of Object.entries(overrides)) {
    if (actionId === null) delete out[chord];
    else out[chord] = actionId;
  }
  return out;
}

/** action id -> every chord bound to it, in table order. */
export function chordsByAction(bindings: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [chord, actionId] of Object.entries(bindings)) (out[actionId] ??= []).push(chord);
  return out;
}

export interface ChordConflict {
  /** The already-bound chord that clashes. */
  chord: string;
  actionId: string;
  /** `same`: identical chord. `prefix`: the existing chord is a prefix of the
   *  new one (typing it would fire first). `extension`: the new chord is a
   *  prefix of the existing one (which would become unreachable). */
  kind: "same" | "prefix" | "extension";
}

function isPrefix(a: readonly string[], b: readonly string[]): boolean {
  return a.length <= b.length && a.every((k, i) => k === b[i]);
}

/**
 * Every binding in `bindings` that `chord` would collide with, ignoring any
 * binding already owned by `actionId` (rebinding an action over its own chord
 * is not a conflict). Returns [] when the chord is free; an unparseable chord
 * throws, same as `createKeymap` would.
 */
export function chordConflicts(
  bindings: Record<string, string>,
  chord: string,
  actionId: string,
  leader: string = "\\",
): ChordConflict[] {
  const steps = chordStepKeys(chord, leader);
  const out: ChordConflict[] = [];
  for (const [other, otherAction] of Object.entries(bindings)) {
    if (otherAction === actionId) continue;
    if (other === chord) {
      out.push({ chord: other, actionId: otherAction, kind: "same" });
      continue;
    }
    let otherSteps: string[];
    try {
      otherSteps = chordStepKeys(other, leader);
    } catch {
      continue; // a malformed existing binding is keymap-config's problem
    }
    if (isPrefix(otherSteps, steps)) out.push({ chord: other, actionId: otherAction, kind: "prefix" });
    else if (isPrefix(steps, otherSteps)) out.push({ chord: other, actionId: otherAction, kind: "extension" });
  }
  return out;
}

/** `null` when the chord came from the preset (an explicit unbind), removed
 *  outright when it was a user row (back to whatever the preset says). */
function clearChord(preset: Record<string, string>, overrides: Record<string, string | null>, chord: string): void {
  if (chord in preset) overrides[chord] = null;
  else delete overrides[chord];
}

export type RebindMode = "replace" | "swap";

/**
 * The overrides map after binding `chord` to `actionId`.
 *
 * `replace` unbinds whatever clashed; `swap` hands the conflicting action
 * this action's previous chord instead of dropping it. The action's own old
 * chords are always released, so an action never accumulates bindings by
 * being re-recorded. Pure — the caller feeds the result back through
 * `resolveKeymapConfigWith`.
 */
export function rebind(
  preset: Record<string, string>,
  overrides: Record<string, string | null>,
  actionId: string,
  chord: string,
  mode: RebindMode = "replace",
  leader: string = "\\",
): Record<string, string | null> {
  const next: Record<string, string | null> = { ...overrides };
  const bindings = mergeBindings(preset, overrides);
  const prevChords = Object.entries(bindings)
    .filter(([, id]) => id === actionId)
    .map(([c]) => c);
  const prev = prevChords[0];
  for (const c of prevChords) clearChord(preset, next, c);
  for (const conflict of chordConflicts(bindings, chord, actionId, leader)) {
    if (conflict.chord !== chord) clearChord(preset, next, conflict.chord);
    if (mode === "swap" && prev !== undefined && prev !== chord) next[prev] = conflict.actionId;
    else if (conflict.chord === chord) clearChord(preset, next, conflict.chord);
  }
  next[chord] = actionId;
  return next;
}

/** Overrides with every chord for `actionId` released (the action ends up
 *  with no binding at all). */
export function unbindAction(
  preset: Record<string, string>,
  overrides: Record<string, string | null>,
  actionId: string,
): Record<string, string | null> {
  const next: Record<string, string | null> = { ...overrides };
  for (const [chord, id] of Object.entries(mergeBindings(preset, overrides))) {
    if (id === actionId) clearChord(preset, next, chord);
  }
  return next;
}

/** Overrides with every row that touches `actionId` dropped — the action goes
 *  back to exactly what the preset gives it. */
export function resetAction(
  preset: Record<string, string>,
  overrides: Record<string, string | null>,
  actionId: string,
): Record<string, string | null> {
  const next: Record<string, string | null> = {};
  for (const [chord, id] of Object.entries(overrides)) {
    if (id === actionId) continue;
    if (id === null && preset[chord] === actionId) continue;
    next[chord] = id;
  }
  return next;
}
