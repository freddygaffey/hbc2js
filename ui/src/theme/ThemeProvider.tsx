// ui/src/theme/ThemeProvider.tsx — runtime theme + density switching
// (spec 22 §2: density is a toggle, not a rebuild).
//
// The state itself lives in ./store.ts (a vanilla useSyncExternalStore
// store, like ui/src/actions/store.ts) so code OUTSIDE React — the
// `view.themeToggle` keymap action and the `:set theme <preset>` command
// (docs/UI-BURS.md #5/#6) — read and change the SAME theme the Settings
// dialog does. This component is now a thin React view over that store.
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { PRESET_NAMES } from "./apply.ts";
import { getThemeState, setThemeDensity, setThemePreset, subscribeTheme } from "./store.ts";
import type { Density } from "./tokens.ts";

interface ThemeCtx {
  readonly preset: string;
  readonly presets: readonly string[];
  readonly density: Density;
  setPreset: (name: string) => void;
  setDensity: (d: Density) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const state = useSyncExternalStore(subscribeTheme, getThemeState, getThemeState);

  const value = useMemo<ThemeCtx>(
    () => ({
      preset: state.preset,
      presets: PRESET_NAMES,
      density: state.density,
      setPreset: setThemePreset,
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
