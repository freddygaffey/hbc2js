// Type declaration for `app-metrics.mjs`, so `tests/gate/tools/app-metrics.test.ts`
// (a `.ts` file, under `tsconfig.json`'s strict settings with no `allowJs`) can
// import it typed. Mirrors `tools/passes-metrics.d.mts`'s convention.
export interface PerKMetric {
  readonly count: number;
  readonly per1kLines: number;
}

export interface AppReadabilityMetrics {
  readonly registers: PerKMetric;
  readonly reflectApply: PerKMetric;
  readonly anonFnNames: PerKMetric;
  readonly hbcHelperCalls: PerKMetric;
}

export interface AppSplitClassification {
  readonly libraryModuleCount: number;
  readonly customModuleCount: number;
  readonly unknownModuleCount: number;
  readonly percentLibraryByWeight: number;
  readonly percentCustomByWeight: number;
}

export type AppSplitResult =
  | { readonly ok: true; readonly moduleCount: number; readonly fileCount: number; readonly classification: AppSplitClassification | null }
  | { readonly ok: false; readonly reason: string };

export interface AppMetricsFailed {
  readonly bundle: string;
  readonly bundleBytes: number;
  readonly decompile: { readonly ok: false; readonly wallMs: number; readonly error: { readonly code: string; readonly message: string } };
}

export interface AppMetricsOk {
  readonly bundle: string;
  readonly bundleBytes: number;
  readonly decompile: { readonly ok: true; readonly wallMs: number };
  readonly totalFunctions: number;
  readonly stubbedFunctions: { readonly count: number; readonly pct: number };
  readonly unresolvedEnvMarkers: number;
  readonly outputBytes: number;
  readonly lineCount: number;
  readonly nodeCheck: { readonly ok: true } | { readonly ok: false; readonly message: string };
  readonly readability: AppReadabilityMetrics;
  readonly helpersUsed: number;
  readonly split?: AppSplitResult;
}

export type AppMetricsResult = AppMetricsFailed | AppMetricsOk;

export function measureApp(bundlePath: string, opts?: { readonly split?: boolean }): Promise<AppMetricsResult>;
