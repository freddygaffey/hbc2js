// docs/specs/00-project-skeleton.md §2.1 — D13 gate/sweep tier selection from env.
// A sweep test file starts with `requireSweep(t)` so a bare `npm test` never spends
// minutes on it.
import type { TestContext } from "node:test";

export type Tier = "gate" | "sweep" | "all";

export function currentTier(): Tier {
  const v = process.env["HBC2JS_TIER"];
  if (v === "sweep" || v === "all") return v;
  return "gate";
}

/** Call at the top of a sweep-tier test body. Skips (does not fail) when the tier
 *  isn't sweep/all, so `HBC2JS_TIER` unset means no sweep file executes a body. */
export function requireSweep(t: TestContext): boolean {
  const tier = currentTier();
  if (tier !== "sweep" && tier !== "all") {
    t.skip(`HBC2JS_TIER=${tier}: sweep tier not requested`);
    return false;
  }
  return true;
}

export function requireOracles(): boolean {
  return process.env["HBC2JS_REQUIRE_ORACLES"] === "1";
}
