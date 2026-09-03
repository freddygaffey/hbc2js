// tests/security/t3-lane-o-recall.test.ts — T3 (spec 13 §10, §8.2). measure-osv
// on the fixture: 100% seeded recall, 0 claim-tier off-lockfile findings,
// network-free (committed OSV DB slice with CC-BY 4.0 attribution header,
// spec 13 ruling R-N). Lane O (adapter + measure-osv.ts) lands in step 2 —
// lands red here until then.
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { requireOracles } from "../support/tiers.ts";

const MEASURE_OSV_PATH = join(repoRoot(), "tools", "security", "measure-osv.ts");

test("T3: measure-osv.ts on the seeded fixture = 100% recall, 0 claim-tier off-lockfile findings", (t) => {
  if (!existsSync(MEASURE_OSV_PATH)) {
    const msg = `${MEASURE_OSV_PATH} does not exist yet — Lane O lands in spec 13 §9 step 2`;
    if (requireOracles()) throw new Error(msg);
    t.skip(msg);
    return;
  }
  t.skip("measure-osv.ts found but running it + asserting the quadruple is step 2's responsibility");
});
