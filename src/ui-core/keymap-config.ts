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
import { resolveKeymapConfigWith, type KeymapConfig, type PresetTable } from "./keymap-resolve.ts";

export type { KeymapConfig } from "./keymap-resolve.ts";

const PRESETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "presets");

export const PRESET_NAMES = ["default", "vim", "ghidra"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

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

/**
 * Validates and resolves a `ui/keymap.json` config into `createKeymap`
 * options. Throws, listing valid ids, if an override names an action id
 * that `registry` does not have.
 *
 * `presets` is an optional preloaded `name -> bindings` table, for callers
 * that cannot read the preset files off disk: the browser shell
 * (`ui/src/keymap-config.ts`) imports the same `presets/*.json` through the
 * bundler and calls `resolveKeymapConfigWith` (./keymap-resolve.ts, which
 * holds all the validation) directly. Omitted, the preset is read from
 * `presets/` here and handed to the same pure resolver.
 */
export function resolveKeymapConfig(config: KeymapConfig, registry: Registry, presets?: PresetTable): CreateKeymapOptions {
  const table: PresetTable = presets ?? { [config.preset]: loadPreset(config.preset) };
  return resolveKeymapConfigWith(config, registry, table);
}
