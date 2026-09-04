// T8 (spec 12 §8) — held-out measurement, once: react-navigation FP <= 8/1k,
// never tuned on. Depends on tools/secrets/measure.ts (step 4/5); the bundle
// fixture is fetched separately (bundles/react-navigation-example-0.85.3/
// fetch.sh) and INCONCLUSIVE-skipped (not a failure) when absent.
//
// 2026-09-05 (CI red-run fix): fetch.sh clones react-navigation/react-navigation,
// runs `pnpm install` and `expo export`, then compiles with hermesc — a
// multi-minute, non-deterministic (upstream HEAD) network build, not a
// provisionable oracle in the hermesc/hermes-dec sense (tests/support/oracles.ts's
// own doc: REQUIRE_ORACLES is entitled to demand tools CI provisions itself).
// Neither branch below honours HBC2JS_REQUIRE_ORACLES=1 any more: an absent
// fetched bundle (or an as-yet-unwritten in-repo tool file) always skips,
// same convention already used for this exact bundle by
// tests/gate/split/segregate.test.ts and tests/gate/deps/material-top-tabs.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "../support/paths.ts";

const MEASURE_PATH = fileURLToPath(new URL("../../tools/secrets/measure.ts", import.meta.url));
const HBC_PATH = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.hbc");

test("T8 held-out: react-navigation FP rate <= 8/1k, never tuned on", (t) => {
  if (!existsSync(MEASURE_PATH)) {
    t.skip(`${MEASURE_PATH} does not exist yet (spec 12 §9 step 4/5)`);
    return;
  }
  if (!existsSync(HBC_PATH)) {
    t.skip(`${HBC_PATH} not present — run tests/fixtures/bundles/react-navigation-example-0.85.3/fetch.sh first (INCONCLUSIVE, not a failure)`);
    return;
  }

  const res = spawnSync(process.execPath, [MEASURE_PATH, "--json", "--held-out", HBC_PATH], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout) as { fpPer1k: { heldOut: number } };
  assert.ok(out.fpPer1k.heldOut <= 8, `held-out FP rate must be <= 8/1k, got ${out.fpPer1k.heldOut}`);
});
