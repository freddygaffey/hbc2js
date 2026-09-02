// docs/BUGS.md (2026-09-01, "deps --confirm sweep verification") — `--confirm`
// does real npm registry lookups and `npm install`s, so a sweep test that
// exercises it is network-luck-dependent the same way an oracle-dependent
// sweep test is hermes-dec-binary-luck-dependent. Mirrors
// tests/support/oracles.ts's requireOracle: skip gracefully (INCONCLUSIVE,
// not a failure) when the dependency is missing, and hard-fail only when the
// caller explicitly asked to require it (HBC2JS_REQUIRE_NETWORK=1, the
// network analogue of HBC2JS_REQUIRE_ORACLES).
import type { TestContext } from "node:test";

const NPM_REGISTRY_PROBE_URL = "https://registry.npmjs.org/react-native";

export function requireNetworkFlag(): boolean {
  return process.env["HBC2JS_REQUIRE_NETWORK"] === "1";
}

/** Returns `true` if a real npm registry fetch succeeds within a short
 *  timeout, otherwise a human-readable reason it didn't (never throws). */
export async function checkNetworkAvailable(): Promise<true | string> {
  try {
    const res = await fetch(NPM_REGISTRY_PROBE_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return `npm registry probe returned HTTP ${res.status}`;
    return true;
  } catch (e) {
    return `npm registry unreachable (${(e as Error).message})`;
  }
}

/** Call before a sweep test body that needs real network/npm access. Skips
 *  (returns false) when it's unavailable, unless HBC2JS_REQUIRE_NETWORK=1,
 *  in which case it throws instead so a CI lane that opted in to requiring
 *  network sees a real failure rather than a silently-green skip. */
export async function requireNetwork(t: TestContext): Promise<boolean> {
  const reason = await checkNetworkAvailable();
  if (reason !== true) {
    if (requireNetworkFlag()) throw new Error(`HBC2JS_REQUIRE_NETWORK=1 but network is unavailable: ${reason}`);
    t.skip(`network unavailable, skipping (INCONCLUSIVE, not a failure): ${reason}`);
    return false;
  }
  return true;
}

/** Wrap a network/npm-dependent operation (e.g. `--confirm`'s registry
 *  lookups and scratch `npm install`s) that can still fail mid-run even
 *  after the up-front probe passed (registry flake, npm itself missing,
 *  transient DNS blip). Skips gracefully unless HBC2JS_REQUIRE_NETWORK=1. */
export async function runRequiringNetwork<T>(t: TestContext, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const reason = `${(e as Error).message}`;
    if (requireNetworkFlag()) throw e;
    t.skip(`network/npm operation failed, skipping (INCONCLUSIVE, not a failure): ${reason}`);
    return { ok: false };
  }
}
