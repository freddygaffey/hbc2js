// Ambient type declaration for pick.mjs, so a `.ts` test (with `allowJs` off,
// per tsconfig.json) can import it without a TS7016 "implicitly has an 'any'
// type" error. Kept minimal and hand-in-sync with pick.mjs's exports —
// docs/specs/24-compute-node.md §5 item 5, tests/gate/tools/deb-pick.test.ts.
export interface JobSummary {
  readonly status: string;
}

export interface PickHostResult {
  readonly host: string;
  readonly load: number;
  readonly skipped: readonly { readonly host: string; readonly error: string }[];
}

/** Picks the reachable host with the fewest queued+running jobs. Ties go to
 *  list order. Throws if no host is reachable. */
export function pickHost(
  hosts: readonly string[],
  fetchJobs: (host: string) => Promise<JobSummary[]>,
): Promise<PickHostResult>;
