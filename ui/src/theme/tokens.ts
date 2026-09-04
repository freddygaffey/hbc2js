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
  /** bur 6 (docs/UI-BURS.md #6): which half of the light/dark toggle this
   *  preset is. */
  readonly mode: "dark" | "light";
  /** bur 3/6: presets that are two variants of the same palette (e.g.
   *  "gruvbox-dark"/"gruvbox-light") share a `family`; the theme.toggle
   *  action flips to the sibling in the same family with the opposite
   *  `mode`, falling back to the base dark/light preset when the family has
   *  no such sibling (a dark-only nvim theme like "one-dark"). */
  readonly family: string;
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
  /** Type ramp (spec 20 §1.2): the ONLY font sizes a component may use,
   *  via the `text-xs/sm/base/lg` Tailwind utilities (ui/src/theme/theme.css
   *  maps them onto these). Never a per-view `text-[Npx]`. */
  readonly type: {
    readonly xs: string;
    readonly sm: string;
    readonly base: string;
    readonly lg: string;
  };
  /** Two elevation levels, flat-and-bordered (spec 20 §1.2: "a dense pro
   *  tool wants flat and bordered, not shadow-heavy"). `level0` is a base
   *  panel; `level1` is one step up (a popover/menu/modal). */
  readonly elevation: {
    readonly level0: { readonly bg: string; readonly border: string };
    readonly level1: { readonly bg: string; readonly border: string };
  };
  /** Border set beyond `palette.border`'s single divider colour: `strong`
   *  for an emphasised divider, `focus` for the accent-coloured ring
   *  cm-theme.ts and the token/search highlights use. */
  readonly border: {
    readonly strong: string;
    readonly focus: string;
  };
  /** Syntax palette shared by ui/src/listing/cm-theme.ts (source) and the
   *  disasm view (ui/src/listing/disasm-highlight.ts), one set of names so
   *  both panes read the same colours. */
  readonly syntax: {
    readonly comment: string;
    readonly keyword: string;
    readonly string: string;
    readonly number: string;
    readonly function: string;
    readonly variable: string;
    readonly operator: string;
    readonly invalid: string;
  };
}

/** ui/theme.json — names a preset and may override any token path. */
export interface ThemeConfig {
  readonly preset: string;
  readonly overrides?: DeepPartial<ThemePreset>;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
