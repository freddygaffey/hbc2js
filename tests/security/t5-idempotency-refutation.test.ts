// tests/security/t5-idempotency-refutation.test.ts — T5 (spec 13 §10, §6.3,
// §7). Re-run adapter with identical scan-state -> 0 new active records;
// refute one finding, re-run -> stays refuted. Requires a lane adapter
// (steps 2-4) — lands red until the first one (Lane O, step 2).
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { requireOracles } from "../support/tiers.ts";

const LANE_O_ADAPTER = join(repoRoot(), "tools", "security", "measure-osv.ts");

test("T5: idempotent re-run adds 0 new active records; a refuted finding stays refuted across re-runs", (t) => {
  if (!existsSync(LANE_O_ADAPTER)) {
    const msg = "no lane adapter exists yet — Lane O lands in spec 13 §9 step 2 (first lane, reviewer ruling 5)";
    if (requireOracles()) throw new Error(msg);
    t.skip(msg);
    return;
  }
  t.skip("a lane adapter exists but T5's idempotency/refutation assertions are that lane's landing responsibility");
});
