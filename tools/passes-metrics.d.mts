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

// docs/specs/passes/03-global-access.md §7's corpus metric.
export interface GlobalAccessPerFixtureMetric {
  readonly fixture: string;
  readonly version: number;
  readonly functions: number;
  readonly cleanFunctionsBefore: number;
  readonly cleanFunctionsAfter: number;
}

export interface GlobalAccessMetricsResult {
  readonly functionCount: number;
  readonly cleanFunctionPct: number;
  readonly cleanFunctionPctBefore: number;
  readonly globalThisOccurrences: ReductionMetric;
  readonly perFixture: readonly GlobalAccessPerFixtureMetric[];
}

export function measureGlobalAccess(versions?: readonly number[]): GlobalAccessMetricsResult;

// docs/specs/passes/04-call-shape.md §7's corpus metric.
export interface CallShapePerFixtureMetric {
  readonly fixture: string;
  readonly version: number;
  readonly functions: number;
  readonly cleanFunctionsBefore: number;
  readonly cleanFunctionsAfter: number;
}

export interface CallShapeMetricsResult {
  readonly functionCount: number;
  readonly cleanFunctionPct: number;
  readonly cleanFunctionPctBefore: number;
  readonly perFixture: readonly CallShapePerFixtureMetric[];
}

export function measureCallShape(versions?: readonly number[]): CallShapeMetricsResult;

export interface CallShapeBundleResult {
  readonly functionCount: number;
  readonly cleanFunctionPct: number;
  readonly cleanFunctionPctBefore: number;
}

export function measureCallShapeBundle(bundlePath: string): CallShapeBundleResult;

// docs/specs/passes/05-fn-naming.md §7's corpus metric.
export interface FnNamingPerFixtureMetric {
  readonly fixture: string;
  readonly version: number;
  readonly functions: number;
  readonly named: number;
}

export interface FnNamingMetricsResult {
  readonly functionCount: number;
  readonly namedPct: number;
  readonly namedPctBefore: number;
  readonly perFixture: readonly FnNamingPerFixtureMetric[];
}

export function measureFnNaming(versions?: readonly number[]): FnNamingMetricsResult;

export interface FnNamingBundleResult {
  readonly functionCount: number;
  readonly namedPct: number;
  readonly namedPctBefore: number;
  readonly survivingFnTokens: number;
}

export function measureFnNamingBundle(bundlePath: string): FnNamingBundleResult;
