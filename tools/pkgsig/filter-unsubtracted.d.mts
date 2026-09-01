// Ambient type declaration for filter-unsubtracted.mjs, so a `.ts` test (with
// `allowJs` off, per tsconfig.json) can import it without a TS7016
// "implicitly has an 'any' type" error. Kept minimal and hand-in-sync with
// the one function this script exports for programmatic use — CONSOLIDATION
// 28, tests/gate/tools/filter-unsubtracted.test.ts.
export interface RejectedSigFile {
  readonly package: string;
  readonly version: string;
  readonly hbcVersion: number;
  readonly functionCount: number | null;
}

/** Quarantines every non-baseline signature file in `dir` whose
 *  `subtractedBaselines` marker is empty (baseline subtraction never ran)
 *  into `dir/_rejected-unsubtracted/`, and drops their entries from
 *  `dir/index.json` if present. Returns the list of rejected files. */
export function filterUnsubtracted(dir: string): readonly RejectedSigFile[];
