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

// Density polish (wave-2 activity landing): both dials persist across a
// reload. Every localStorage call is wrapped — a private-browsing tab (or
// any other reason `Storage` throws) degrades to the `ui/theme.json`
// default, never to a crash.
const PRESET_KEY = "hbc2js.theme.preset";
const DENSITY_KEY = "hbc2js.theme.density";

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
    // ignore — best-effort persistence only.
  }
}

export function ThemeProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [preset, setPresetState] = useState<string>(loadPreset);
  // Comfortable is the MVP default: the shell must not feel cramped.
  const [density, setDensityState] = useState<Density>(() => loadDensity(resolveTheme(loadPreset()).density));

  useEffect(() => {
    applyTheme(resolveTheme(preset), density);
  }, [preset, density]);

  const setPreset = (name: string): void => {
    setPresetState(name);
    save(PRESET_KEY, name);
  };
  const setDensity = (d: Density): void => {
    setDensityState(d);
    save(DENSITY_KEY, d);
  };

  const value = useMemo<ThemeCtx>(() => ({ preset, presets: PRESET_NAMES, density, setPreset, setDensity }), [preset, density]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (v === null) throw new Error("useTheme outside ThemeProvider");
  return v;
}
