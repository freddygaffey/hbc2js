// Type declaration for `generate.mjs`, so `.ts` test files (strict
// tsconfig.json, no allowJs) can import it typed. Mirrors
// `tools/app-metrics.d.mts`'s convention.
export interface AppManifest {
  readonly schemaVersion: number;
  readonly seed: string;
  readonly seed32: number;
  readonly appName: string;
  readonly routerShape: "stack" | "tabs" | "weird";
  readonly depStyle: "static" | "lazyRequire" | "reexport";
  readonly screens: readonly string[];
  readonly rnVersion: string;
  readonly files: readonly string[];
  readonly fingerprint: string;
}

export function generateApp(
  seed: string | number,
  opts?: { readonly rnVersion?: string },
): {
  readonly manifest: AppManifest;
  readonly files: ReadonlyMap<string, string>;
};
