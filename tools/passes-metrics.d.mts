// Type declaration for `passes-metrics.mjs`, so `tests/gate/passes/expr-rebuild-metrics.test.ts`
// (a `.ts` file, under `tsconfig.json`'s strict settings with no `allowJs`) can import it typed.
export interface PerFixtureMetric {
  readonly fixture: string;
  readonly beforeRegs: number;
  readonly afterRegs: number;
}

export interface ReductionMetric {
  readonly before: number;
  readonly after: number;
  readonly reductionPct: number;
}

export interface PassesMetricsResult {
  readonly fixtureCount: number;
  readonly registerOccurrences: ReductionMetric;
  readonly medianStatementsPerFunction: ReductionMetric;
  readonly perFixture: readonly PerFixtureMetric[];
}

export function measure(): PassesMetricsResult;
