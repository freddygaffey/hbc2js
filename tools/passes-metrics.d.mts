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

// docs/specs/passes/07-var-naming.md §8's corpus metric.
export interface VarNamingPerFixtureMetric {
  readonly fixture: string;
  readonly version: number;
  readonly variant: string;
  readonly registers: number;
  readonly named: number;
}

export interface VarNamingMetricsResult {
  readonly registerCount: number;
  readonly survivingRegisters: number;
  readonly namedPct: number;
  readonly namedPctBefore: number;
  readonly perFixture: readonly VarNamingPerFixtureMetric[];
  /** (fixture, version, variant) triples whose decompile threw with var-naming
   *  skipped as well as on — pre-existing, ledgered failures, reported not counted. */
  readonly skipped: readonly { readonly fixture: string; readonly version: number; readonly variant: string; readonly error: string }[];
}

export function measureVarNaming(versions?: readonly number[], variants?: readonly string[]): VarNamingMetricsResult;

export interface VarNamingBundleResult {
  readonly registerCount: number;
  readonly survivingRegisters: number;
  readonly namedPct: number;
  readonly registerTokensBefore: number;
  readonly registerTokensAfter: number;
}

export function measureVarNamingBundle(bundlePath: string): VarNamingBundleResult;

// docs/specs/passes/09-if-chain.md §7's corpus metric.
export interface IfChainVersionMetric {
  readonly elseOccurrences: ReductionMetric;
  /** Median per-function maximum statement-nesting depth, all functions. */
  readonly medianMaxDepth: { readonly before: number; readonly after: number };
  /** The same median over only the functions that had any nesting to lose
   *  (before-depth >= 2); the corpus median function is a flat helper, so
   *  this is where the spec's depth floor is visible. */
  readonly nestedMedianMaxDepth: { readonly before: number; readonly after: number };
  /** Mean per-function maximum depth — the moved statistic: the rung's wins
   *  concentrate in the deep tail, so both medians sit still while the mean
   *  (and the depth>=5 population) falls. */
  readonly meanMaxDepth: { readonly before: number; readonly after: number };
  /** Spec §8 question 3: C3 annotations surviving to stage B, and how many
   *  are in the printer's printable single-`if` shape. */
  readonly elseIfAnnotated: number;
  readonly elseIfPrintable: number;
}

export interface IfChainMetricsResult {
  readonly perVersion: Readonly<Record<number, IfChainVersionMetric>>;
}

export function measureIfChain(versions?: readonly number[]): IfChainMetricsResult;

// docs/specs/passes/10-switch-raise.md §7's corpus metric.
export interface SwitchRaiseFixtureMetric {
  readonly switchCount: number;
  /** `break L\d+;` statements inside emitted `switch` blocks. */
  readonly labelledBreaksInSwitch: number;
  /** `break;` immediately after another break inside a `switch` (F12). */
  readonly doubledBreaks: number;
}

export interface SwitchRaiseVersionMetric {
  /** `L\d+: {` label declarations across the corpus, all passes vs skip. */
  readonly labelDecls: ReductionMetric;
  readonly perFixture: Readonly<Record<string, SwitchRaiseFixtureMetric>>;
}

export interface SwitchRaiseMetricsResult {
  readonly perVersion: Readonly<Record<number, SwitchRaiseVersionMetric>>;
}

export function measureSwitchRaise(versions?: readonly number[]): SwitchRaiseMetricsResult;
