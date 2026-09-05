// Ambient type declaration for pick.mjs, so a `.ts` test (with `allowJs` off,
// per tsconfig.json) can import it without a TS7016 "implicitly has an 'any'
// type" error. Kept minimal and hand-in-sync with pick.mjs's exports —
// docs/specs/24-compute-node.md §5 item 5, tests/gate/tools/deb-pick.test.ts.
export interface HostInfo {
  readonly score: number;
  readonly fallback?: boolean;
}

export interface PickHostResult {
  readonly host: string;
  readonly score: number;
  readonly results: readonly (HostInfo & { readonly host: string })[];
  readonly skipped: readonly { readonly host: string; readonly error: string }[];
}

/** The load score formula: loadavg[0]/nproc + (queued+running)/maxParallel. */
export function computeLoadScore(
  loadavg1: number,
  nproc: number,
  queued: number,
  running: number,
  maxParallel: number,
): number;

/** Picks the reachable host with the lowest score. Ties go to list order.
 *  Throws if no host is reachable. */
export function pickHost(
  hosts: readonly string[],
  fetchLoad: (host: string) => Promise<HostInfo>,
): Promise<PickHostResult>;
