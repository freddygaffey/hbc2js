// Type declaration for `corpus-regression.mjs`, so a typed `.ts` test can
// import its pure helper functions directly (rather than only shelling out
// to it as a subprocess, the way tests/sweep/e2e/corpus-regression.test.ts
// does). Mirrors tools/app-metrics.d.mts's convention. Only declares the
// exports a typed importer currently uses — extend as needed.
export const CORPUS_APPS: readonly string[];

export function isPlausibleScreenName(name: string): boolean;

/** Ordered, de-duplicated candidate bundle asset paths present in the zip
 *  (conventional exact names, then any `assets/*.hbc`, then other
 *  bundle-shaped fallbacks). See `tools/e2e/corpus-regression.mjs`'s own
 *  doc comment for the exact priority. */
export function pickBundleCandidates(entries: readonly string[]): string[];

export interface CorpusAppOverfitInput {
  readonly decompile: { readonly status: string; readonly errorCode?: string };
  readonly totalModules?: number;
  readonly validJsPct?: number;
  readonly screens?: { readonly detected: number; readonly plausibilityRatio: number };
  readonly navigators?: { readonly detected: number };
  readonly varNaming?: { readonly pct: number; readonly totalRegisters: number };
}

export function detectOverfitFlags(appMetrics: CorpusAppOverfitInput, corpusMedianVarNamedPct: number | null): string[];

export function measureCorpusApp(appName: string, bundlePath: string): unknown;

export function runSweep(opts?: { readonly apps?: readonly string[]; readonly corpusDir?: string; readonly onDeb?: boolean }): unknown;
