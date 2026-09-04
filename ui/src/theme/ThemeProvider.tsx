// ui/src/theme/ThemeProvider.tsx — runtime theme + density switching
// (spec 22 §2: density is a toggle, not a rebuild).
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { applyTheme, DEFAULT_PRESET, PRESET_NAMES, resolveTheme } from "./apply.ts";
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
  const [preset, setPreset] = useState<string>(DEFAULT_PRESET);
  // Comfortable is the MVP default: the shell must not feel cramped.
  const [density, setDensity] = useState<Density>(() => resolveTheme(DEFAULT_PRESET).density);

  useEffect(() => {
    applyTheme(resolveTheme(preset), density);
  }, [preset, density]);

  const value = useMemo<ThemeCtx>(() => ({ preset, presets: PRESET_NAMES, density, setPreset, setDensity }), [preset, density]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (v === null) throw new Error("useTheme outside ThemeProvider");
  return v;
}
