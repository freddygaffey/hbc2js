// ui/src/theme/apply.ts — startup token load (spec 22 §3.4): ui/theme.json
// names a preset (ui/themes/dark.json | light.json) and may override any
// token; the merge is written to `:root` as CSS custom properties
// (`--bg`, `--accent`, `--sev-crit`, `--space-3`, ...). Nothing else in
// ui/src may name a colour — tests/gate/ui/tokens.test.ts enforces it.
import darkPreset from "../../themes/dark.json";
import lightPreset from "../../themes/light.json";
import themeConfig from "../../theme.json";
import type { Density, ThemeConfig, ThemePreset } from "./tokens.ts";

const PRESETS: Readonly<Record<string, ThemePreset>> = {
  dark: darkPreset as ThemePreset,
  light: lightPreset as ThemePreset,
};

export const PRESET_NAMES = Object.keys(PRESETS);

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
  } as ThemePreset;
}

export const DEFAULT_PRESET = config.preset;

/** Writes one resolved theme + density to `:root`. Inline custom properties
 *  on the document element beat any stylesheet `:root` rule, so this also
 *  overrides Tailwind's own defaults for `--font-sans` / `--spacing`. */
export function applyTheme(theme: ThemePreset, density: Density): void {
  const root = document.documentElement;
  const set = (k: string, v: string): void => root.style.setProperty(k, v);
  for (const [k, v] of Object.entries(theme.palette)) set(`--${k}`, v);
  for (const [k, v] of Object.entries(theme.severity)) set(`--sev-${k}`, v);
  for (const [k, v] of Object.entries(theme.spacing)) set(`--space-${k}`, v);
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
