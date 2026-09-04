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

/** bur 3/6: the distinct `family` values across every shipped preset, in
 *  `PRESET_NAMES` order, each listed once — what the Settings "theme
 *  family" dropdown offers (the family's dark/light variant, if any, is
 *  then picked by the mode toggle, never by this list). */
export function families(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of PRESET_NAMES) {
    const f = presetOf(name).family;
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

/** The preset in `family` matching `mode`; if the family has no such variant
 *  (a dark-only preset like "one-dark"), whichever preset the family does
 *  have; if the family is unknown, the base `mode` preset ("dark"/"light",
 *  which always exist). */
export function presetForFamily(family: string, mode: "dark" | "light"): string {
  const exact = Object.entries(PRESETS).find(([, p]) => p.family === family && p.mode === mode);
  if (exact !== undefined) return exact[0];
  const any = Object.entries(PRESETS).find(([, p]) => p.family === family);
  if (any !== undefined) return any[0];
  return mode;
}

/** bur 6 (docs/UI-BURS.md #6): the dark/light "partner" of `name` — the
 *  theme.toggle action and Settings' mode switch both flip to this. Same
 *  family, opposite mode, when one exists; otherwise the base `dark`/`light`
 *  preset for the opposite mode (every preset ships one of the two modes, so
 *  this is always defined). */
export function partnerPreset(name: string): string {
  const p = presetOf(name);
  const wantMode: "dark" | "light" = p.mode === "dark" ? "light" : "dark";
  const sibling = Object.entries(PRESETS).find(([, q]) => q.family === p.family && q.mode === wantMode);
  return sibling !== undefined ? sibling[0] : wantMode;
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
