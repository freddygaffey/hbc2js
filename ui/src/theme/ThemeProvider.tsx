// ui/src/theme/ThemeProvider.tsx — runtime theme + density switching
// (spec 22 §2: density is a toggle, not a rebuild).
//
// The state itself lives in ./store.ts (a vanilla useSyncExternalStore
// store, like ui/src/actions/store.ts) so code OUTSIDE React — the
// `view.themeToggle` keymap action and the `:set theme <preset>` command
// (docs/UI-BURS.md #5/#6) — read and change the SAME theme the Settings
// dialog does. This component is now a thin React view over that store.
//
// bur 12 (docs/UI-BURS.md #12): the context exposes the two persisted
// slots (`light`, `dark`) and the active `mode`, plus each mode's preset
// list (for Settings' two selects) — never one flat list of every preset.
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { activePreset } from "@ui-core/theme-slots.ts";
import { presetsOfMode } from "./apply.ts";
import { getThemeState, setThemeDensity, setThemeSlot, subscribeTheme, toggleTheme } from "./store.ts";
import type { Density } from "./tokens.ts";

interface ThemeCtx {
  readonly light: string;
  readonly dark: string;
  readonly mode: "light" | "dark";
  /** The preset actually on screen (the active slot's value). */
  readonly preset: string;
  readonly lightPresets: readonly string[];
  readonly darkPresets: readonly string[];
  readonly density: Density;
  setLight: (name: string) => void;
  setDark: (name: string) => void;
  toggle: () => void;
  setDensity: (d: Density) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const state = useSyncExternalStore(subscribeTheme, getThemeState, getThemeState);

  const value = useMemo<ThemeCtx>(
    () => ({
      light: state.light,
      dark: state.dark,
      mode: state.mode,
      preset: activePreset(state),
      lightPresets: presetsOfMode("light"),
      darkPresets: presetsOfMode("dark"),
      density: state.density,
      setLight: (name: string) => setThemeSlot("light", name),
      setDark: (name: string) => setThemeSlot("dark", name),
      toggle: toggleTheme,
      setDensity: setThemeDensity,
    }),
    [state],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (v === null) throw new Error("useTheme outside ThemeProvider");
  return v;
}
