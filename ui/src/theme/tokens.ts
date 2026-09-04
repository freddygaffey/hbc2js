// ui/src/theme/tokens.ts — the shape of ui/theme.json and ui/themes/*.json
// (spec 22 §3.4: ONE config; components read tokens, never raw values).
export type Density = "compact" | "comfortable";

export interface DensitySpec {
  /** Tailwind's `--spacing` unit at this density (drives every padding and gap utility). */
  readonly unit: string;
  /** Root font-size at this density (drives every rem-based text-* utility). */
  readonly fontSize: string;
  /** Nominal list-row height, for trees and the listing gutter. */
  readonly rowHeight: string;
}

export interface ThemePreset {
  readonly name: string;
  readonly palette: {
    readonly bg: string;
    readonly surface: string;
    readonly "surface-2": string;
    readonly border: string;
    readonly text: string;
    readonly "text-muted": string;
    readonly accent: string;
    readonly "accent-fg": string;
  };
  readonly severity: {
    readonly crit: string;
    readonly high: string;
    readonly med: string;
    readonly ok: string;
  };
  readonly fonts: { readonly sans: string; readonly mono: string };
  readonly radius: string;
  readonly spacing: Readonly<Record<string, string>>;
  readonly density: Density;
  readonly densities: Readonly<Record<Density, DensitySpec>>;
}

/** ui/theme.json — names a preset and may override any token path. */
export interface ThemeConfig {
  readonly preset: string;
  readonly overrides?: DeepPartial<ThemePreset>;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
