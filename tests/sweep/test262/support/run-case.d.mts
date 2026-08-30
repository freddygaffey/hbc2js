// Type declaration for `run-case.mjs`, so `corpus.test.ts` (a `.ts` file,
// under `tsconfig.json`'s strict settings with no `allowJs`) can import it
// typed — same pattern as `tools/passes-metrics.d.mts`.
export interface RunCaseResult {
  readonly phase: "none" | "parse" | "runtime";
  readonly errorName?: string;
  readonly errorMessage?: string;
}

export interface NegativeSpec {
  readonly phase: string;
  readonly type: string;
}

export function runCase(source: string): RunCaseResult;
export function matchesExpectation(negative: NegativeSpec | null, result: RunCaseResult): boolean;
