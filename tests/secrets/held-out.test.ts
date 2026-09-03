// T8 (spec 12 §8) — held-out measurement, once: react-navigation FP <= 8/1k,
// never tuned on. Depends on tools/secrets/measure.ts (step 4/5); the bundle
// fixture is fetched separately (bundles/fetch.sh) and INCONCLUSIVE-skipped
// (not a failure) when absent, same convention as
// tests/sweep/deps/confirm-react-navigation.test.ts.
// HBC2JS_REQUIRE_ORACLES=1 turns that skip into a failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "../support/paths.ts";
import { requireOracles } from "../support/tiers.ts";

const MEASURE_PATH = fileURLToPath(new URL("../../tools/secrets/measure.ts", import.meta.url));
const HBC_PATH = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.hbc");

test("T8 held-out: react-navigation FP rate <= 8/1k, never tuned on", (t) => {
  if (!existsSync(MEASURE_PATH)) {
    const msg = `${MEASURE_PATH} does not exist yet (spec 12 §9 step 4/5)`;
    if (requireOracles()) throw new Error(msg);
    t.skip(msg);
    return;
  }
  if (!existsSync(HBC_PATH)) {
    const msg = `${HBC_PATH} not present — run tests/fixtures/bundles/fetch.sh first (INCONCLUSIVE, not a failure)`;
    if (requireOracles()) throw new Error(msg);
    t.skip(msg);
    return;
  }

  const res = spawnSync(process.execPath, [MEASURE_PATH, "--json", "--held-out", HBC_PATH], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout) as { fpPer1k: { heldOut: number } };
  assert.ok(out.fpPer1k.heldOut <= 8, `held-out FP rate must be <= 8/1k, got ${out.fpPer1k.heldOut}`);
});
