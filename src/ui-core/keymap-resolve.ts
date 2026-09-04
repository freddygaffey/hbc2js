// src/ui-core/keymap-resolve.ts — the pure half of keymap-config.ts
// (docs/specs/22-ui-mvp.md §3.2). `keymap-config.ts` reads the preset files
// off disk with `node:fs`, which a browser bundle cannot even *import* (the
// ui/ package has no node types and no fs); the browser shell imports the
// same `presets/*.json` through Vite and calls this instead, so preset
// resolution and override validation exist exactly once for both callers.
import type { Registry } from "./actions.ts";
import type { CreateKeymapOptions } from "./keymap.ts";

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
