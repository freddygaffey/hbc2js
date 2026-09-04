// src/ui-core/keymap-config.ts — docs/specs/22-ui-mvp.md §3.2. Loads the
// `ui/keymap.json` shape `{ preset: "default"|"vim"|"ghidra", overrides?:
// Record<chord, actionId|null> }`, validates it against a registry (every
// override action id must be registered) and against the known preset
// names, and hands back `CreateKeymapOptions` ready for `createKeymap`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Registry } from "./actions.ts";
import type { CreateKeymapOptions } from "./keymap.ts";

const PRESETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "presets");

export const PRESET_NAMES = ["default", "vim", "ghidra"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export interface KeymapConfig {
  preset: string;
  overrides?: Record<string, string | null>;
}

function loadPresetFile(name: PresetName): Record<string, string> {
  const raw = readFileSync(join(PRESETS_DIR, `${name}.json`), "utf8");
  return JSON.parse(raw) as Record<string, string>;
}

/** Loads a preset by name. Throws, listing valid preset names, if `name` is unknown. */
export function loadPreset(name: string): Record<string, string> {
  if (!(PRESET_NAMES as readonly string[]).includes(name)) {
    throw new Error(`ui-core/keymap-config: unknown preset "${name}" (valid presets: ${PRESET_NAMES.join(", ")})`);
  }
  return loadPresetFile(name as PresetName);
}

/** `loadPreset`'s in-memory twin: same unknown-name error, no disk read. */
function lookupPreset(name: string, presets: Readonly<Record<string, Record<string, string>>>): Record<string, string> {
  const found = presets[name];
  if (found === undefined) {
    throw new Error(`ui-core/keymap-config: unknown preset "${name}" (valid presets: ${PRESET_NAMES.join(", ")})`);
  }
  return found;
}

/**
 * Validates and resolves a `ui/keymap.json` config into `createKeymap`
 * options. Throws, listing valid ids, if an override names an action id
 * that `registry` does not have.
 *
 * `presets` is an optional preloaded `name -> bindings` table, for callers
 * that cannot read the preset files off disk: the browser shell
 * (`ui/src/keymap-config.ts`) imports the same `presets/*.json` through the
 * bundler and passes them in, so this module's `node:fs` read is never
 * reached there. Omitted, the preset is read from `presets/` as before.
 */
export function resolveKeymapConfig(
  config: KeymapConfig,
  registry: Registry,
  presets?: Readonly<Record<string, Record<string, string>>>,
): CreateKeymapOptions {
  const preset = presets === undefined ? loadPreset(config.preset) : lookupPreset(config.preset, presets);
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
