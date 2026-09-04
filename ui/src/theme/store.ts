// ui/src/theme/store.ts — vanilla (non-React) theme state, mirroring
// ui/src/actions/store.ts's useSyncExternalStore pattern. `ThemeProvider` is
// a thin React view over this store so code OUTSIDE React — the
// `view.themeToggle` keymap action and the `:set theme <preset>` command
// (docs/UI-BURS.md #5/#6) — can read and change the SAME theme state the
// Settings dialog does, through exactly one persistence path (localStorage,
// wrapped) and one CSS-variable apply path.
import { applyTheme, DEFAULT_PRESET, PRESET_NAMES, partnerPreset, presetOf, resolveTheme } from "./apply.ts";
import type { Density } from "./tokens.ts";

const PRESET_KEY = "hbc2js.theme.preset";
const DENSITY_KEY = "hbc2js.theme.density";

export interface ThemeState {
  readonly preset: string;
  readonly density: Density;
}

function loadPreset(): string {
  try {
    const v = window.localStorage.getItem(PRESET_KEY);
    return v !== null && PRESET_NAMES.includes(v) ? v : DEFAULT_PRESET;
  } catch {
    return DEFAULT_PRESET;
  }
}

function loadDensity(fallback: Density): Density {
  try {
    const v = window.localStorage.getItem(DENSITY_KEY);
    return v === "compact" || v === "comfortable" ? v : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // best-effort, like every other localStorage use in the shell.
  }
}

let state: ThemeState = { preset: loadPreset(), density: loadDensity(resolveTheme(loadPreset()).density) };

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

function apply(): void {
  applyTheme(resolveTheme(state.preset), state.density);
}

// Applied once at module load (not just on ThemeProvider's first render), so
// the persisted theme is live the instant the module graph is evaluated.
if (typeof window !== "undefined" && typeof document !== "undefined") apply();

export function getThemeState(): ThemeState {
  return state;
}

export function subscribeTheme(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Throws (leaving state unchanged) when `name` is not a known preset —
 *  same contract as `setKeymapConfig`. */
export function setThemePreset(name: string): void {
  presetOf(name);
  state = { ...state, preset: name };
  save(PRESET_KEY, name);
  apply();
  notify();
}

export function setThemeDensity(d: Density): void {
  state = { ...state, density: d };
  save(DENSITY_KEY, d);
  apply();
  notify();
}

/** Bur 6 (docs/UI-BURS.md #6): flips to the active preset's dark/light
 *  partner (`partnerPreset`, ui/src/theme/apply.ts). */
export function toggleTheme(): void {
  setThemePreset(partnerPreset(state.preset));
}
