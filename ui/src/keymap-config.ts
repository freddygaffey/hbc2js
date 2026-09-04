// ui/src/keymap-config.ts — `ui/keymap.json` (`{ preset, overrides }`,
// spec 22 §3) resolved against the repo-root presets. The presets are
// imported through the `@ui-core` alias, so `src/ui-core/presets/*.json` is
// the ONLY place a chord table lives; validation of the overrides happens in
// `@ui-core/keymap-resolve.ts` (shared with the Node-side loader).
//
// This module deliberately does not import the registry: `src/actions/
// registry.ts` owns that and calls `resolveKeymapConfigWith(keymapConfig,
// registry, PRESETS)` itself, which keeps the two free of a cycle.
import raw from "../keymap.json";
import defaultPreset from "@ui-core/presets/default.json";
import vimPreset from "@ui-core/presets/vim.json";
import ghidraPreset from "@ui-core/presets/ghidra.json";
import type { KeymapConfig, PresetTable } from "@ui-core/keymap-resolve.ts";

export type { KeymapConfig } from "@ui-core/keymap-resolve.ts";

/** Every preset spec 22 §3.2 names, keyed by the name `keymap.json` uses. */
export const PRESETS: PresetTable = {
  default: defaultPreset as Record<string, string>,
  vim: vimPreset as Record<string, string>,
  ghidra: ghidraPreset as Record<string, string>,
};

const parsed = raw as { preset?: unknown; overrides?: Record<string, string | null> };

export const keymapConfig: KeymapConfig = {
  preset: typeof parsed.preset === "string" ? parsed.preset : "default",
  ...(parsed.overrides !== undefined ? { overrides: parsed.overrides } : {}),
};

/** Back-compat alias for the shell's earlier `keymap` export. */
export const keymap: KeymapConfig = keymapConfig;

/** True when the editor should mount `@replit/codemirror-vim`. */
export const vimEnabled: boolean = keymapConfig.preset === "vim";
