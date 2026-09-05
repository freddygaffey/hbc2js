// ui/src/theme/apply.ts — startup token load (spec 22 §3.4): ui/theme.json
// names a preset (any file in ui/themes/*.json) and may override any token;
// the merge is written to `:root` as CSS custom properties (`--bg`,
// `--accent`, `--sev-crit`, `--space-3`, ...). Nothing else in ui/src may
// name a colour — tests/gate/ui/tokens.test.ts enforces it.
//
// bur 3 (docs/UI-BURS.md #3): the preset list is every `ui/themes/*.json`
// file, loaded with `import.meta.glob` so adding an nvim/VS Code-common
// preset is "drop a JSON file in ui/themes/", not a code change here.
import themeConfig from "../../theme.json";
import type { Density, ThemeConfig, ThemePreset } from "./tokens.ts";

const presetModules = import.meta.glob<{ default: ThemePreset }>("../../themes/*.json", { eager: true });

const PRESETS: Readonly<Record<string, ThemePreset>> = Object.fromEntries(
  Object.entries(presetModules).map(([path, mod]) => [path.replace(/^.*\//, "").replace(/\.json$/, ""), mod.default]),
);

export const PRESET_NAMES = Object.keys(PRESETS).sort();

const config = themeConfig as ThemeConfig;

export function presetOf(name: string): ThemePreset {
  const p = PRESETS[name];
  if (p === undefined) throw new Error(`ui/theme.json names unknown preset "${name}" (have: ${PRESET_NAMES.join(", ")})`);
  return p;
}

/** The preset named by ui/theme.json, with its `overrides` merged in. */
export function resolveTheme(name: string = config.preset): ThemePreset {
  const base = presetOf(name);
  const o = config.overrides;
  if (o === undefined) return base;
  return {
    ...base,
    ...o,
    palette: { ...base.palette, ...o.palette },
    severity: { ...base.severity, ...o.severity },
    fonts: { ...base.fonts, ...o.fonts },
    spacing: { ...base.spacing, ...o.spacing },
    densities: { ...base.densities, ...o.densities },
    type: { ...base.type, ...o.type },
    elevation: {
      level0: { ...base.elevation.level0, ...o.elevation?.level0 },
      level1: { ...base.elevation.level1, ...o.elevation?.level1 },
    },
    border: { ...base.border, ...o.border },
    syntax: { ...base.syntax, ...o.syntax },
  } as ThemePreset;
}

export const DEFAULT_PRESET = config.preset;

/** bur 12 (docs/UI-BURS.md #12): every preset whose `mode` matches, in
 *  `PRESET_NAMES` order — what Settings' "Light theme"/"Dark theme" selects
 *  each offer. Never the full preset list in one menu (that was the
 *  complaint bur 12 replaces bur 6's family dropdown for). */
export function presetsOfMode(mode: "dark" | "light"): string[] {
  return PRESET_NAMES.filter((name) => presetOf(name).mode === mode);
}

/** `PresetLookup` for `src/ui-core/theme-slots.ts`'s pure slot logic —
 *  `undefined` for an unknown name, otherwise the preset's `mode`. */
export function modeOf(name: string): "dark" | "light" | undefined {
  const p = PRESETS[name];
  return p === undefined ? undefined : p.mode;
}

/** Writes one resolved theme + density to `:root`. Inline custom properties
 *  on the document element beat any stylesheet `:root` rule, so this also
 *  overrides Tailwind's own defaults for `--font-sans` / `--spacing`. */
export function applyTheme(theme: ThemePreset, density: Density): void {
  const root = document.documentElement;
  const set = (k: string, v: string): void => root.style.setProperty(k, v);
  for (const [k, v] of Object.entries(theme.palette)) set(`--${k}`, v);
  for (const [k, v] of Object.entries(theme.severity)) set(`--sev-${k}`, v);
  for (const [k, v] of Object.entries(theme.spacing)) set(`--space-${k}`, v);
  for (const [k, v] of Object.entries(theme.type)) set(`--type-${k}`, v);
  set("--elevation-0-bg", theme.elevation.level0.bg);
  set("--elevation-0-border", theme.elevation.level0.border);
  set("--elevation-1-bg", theme.elevation.level1.bg);
  set("--elevation-1-border", theme.elevation.level1.border);
  set("--border-strong", theme.border.strong);
  set("--border-focus", theme.border.focus);
  for (const [k, v] of Object.entries(theme.syntax)) set(`--syn-${k}`, v);
  set("--font-sans-stack", theme.fonts.sans);
  set("--font-mono-stack", theme.fonts.mono);
  set("--radius", theme.radius);
  const d = theme.densities[density];
  set("--density-unit", d.unit);
  set("--font-size", d.fontSize);
  set("--row-height", d.rowHeight);
  root.dataset["theme"] = theme.name;
  root.dataset["density"] = density;
}
