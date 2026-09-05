// ui/src/theme/store.ts — vanilla (non-React) theme state, mirroring
// ui/src/actions/store.ts's useSyncExternalStore pattern. `ThemeProvider` is
// a thin React view over this store so code OUTSIDE React — the
// `view.themeToggle` keymap action and the `:set theme <preset>` command
// (docs/UI-BURS.md #5/#6) — can read and change the SAME theme state the
// Settings dialog does, through exactly one persistence path (localStorage,
// wrapped) and one CSS-variable apply path.
//
// bur 12 (docs/UI-BURS.md #12): the state is now two persisted SLOTS
// (`light`, `dark`, one preset name each) plus which slot is active. The
// toolbar button and `view.themeToggle` flip the active slot only
// (`toggleTheme`/`toggled`); Settings assigns each slot a preset from that
// mode's presets only (`setThemeSlot`/`withSlot`). The slot-selection LOGIC
// lives in `src/ui-core/theme-slots.ts` (pure, no DOM) so it is unit
// testable; this module owns persistence + CSS application only.
import { modeOf, presetOf, applyTheme, DEFAULT_PRESET, resolveTheme } from "./apply.ts";
import { activePreset, toggled, withPresetActive, withSlot, type ThemeMode, type ThemeSlots } from "@ui-core/theme-slots.ts";
import type { Density } from "./tokens.ts";

const LIGHT_KEY = "hbc2js.theme.light";
const DARK_KEY = "hbc2js.theme.dark";
const MODE_KEY = "hbc2js.theme.mode";
const DENSITY_KEY = "hbc2js.theme.density";

// "light"/"dark" are guaranteed to exist with these modes
// (tests/gate/ui/tokens.test.ts: "every family that ships only one mode
// must be able to fall back to a base dark/light preset").
const DEFAULT_LIGHT = "light";
const DEFAULT_DARK = "dark";
const DEFAULT_MODE: ThemeMode = presetOf(DEFAULT_PRESET).mode;

const lookup = { modeOf };

export interface ThemeState extends ThemeSlots {
  readonly density: Density;
}

function loadSlot(key: string, mode: ThemeMode, fallback: string): string {
  try {
    const v = window.localStorage.getItem(key);
    return v !== null && modeOf(v) === mode ? v : fallback;
  } catch {
    return fallback;
  }
}

function loadMode(): ThemeMode {
  try {
    const v = window.localStorage.getItem(MODE_KEY);
    return v === "light" || v === "dark" ? v : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
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

let state: ThemeState = {
  light: loadSlot(LIGHT_KEY, "light", DEFAULT_LIGHT),
  dark: loadSlot(DARK_KEY, "dark", DEFAULT_DARK),
  mode: loadMode(),
  density: loadDensity(resolveTheme(DEFAULT_PRESET).density),
};

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

function apply(): void {
  applyTheme(resolveTheme(activePreset(state)), state.density);
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

function commit(slots: ThemeSlots): void {
  state = { ...state, ...slots };
  save(LIGHT_KEY, state.light);
  save(DARK_KEY, state.dark);
  save(MODE_KEY, state.mode);
  apply();
  notify();
}

/** Assigns `name` to `mode`'s slot (Settings' "Light theme"/"Dark theme"
 *  selects). Throws — leaving state unchanged — when `name` is not a known
 *  preset of that mode. */
export function setThemeSlot(mode: ThemeMode, name: string): void {
  commit(withSlot(state, mode, name, lookup));
}

/** `:set theme <preset>` (bur 5): names a preset directly, which both fills
 *  its slot and makes it active. Throws on an unknown preset name. */
export function setThemePreset(name: string): void {
  commit(withPresetActive(state, name, lookup));
}

export function setThemeDensity(d: Density): void {
  state = { ...state, density: d };
  save(DENSITY_KEY, d);
  apply();
  notify();
}

/** Bur 12 (docs/UI-BURS.md #12): flips the active slot — the toolbar
 *  button, `view.themeToggle`, and the command palette's "Toggle theme" row
 *  all call this. */
export function toggleTheme(): void {
  commit(toggled(state));
}
