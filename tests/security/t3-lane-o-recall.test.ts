// tests/security/t3-lane-o-recall.test.ts — T3 (spec 13 §10, §8.2). measure-osv
// on the fixture: 100% seeded recall, 0 claim-tier off-lockfile findings,
// network-free (committed OSV DB slice with CC-BY 4.0 attribution header,
// spec 13 ruling R-N).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runDeps } from "../../src/deps/index.ts";
import { loadOsvSlice, matchOsv } from "../../src/security/osv-adapter.ts";
import { repoRoot } from "../support/paths.ts";

const FIXTURE_DIR = join(repoRoot(), "tests", "fixtures", "security", "vuln-app");

test("T3: Lane O adapter on the seeded fixture = 100% recall, 0 claim-tier off-lockfile findings", async () => {
  const groundTruth = JSON.parse(readFileSync(join(FIXTURE_DIR, "ground-truth.json"), "utf8")) as { readonly lockfilePins: readonly { readonly package: string; readonly version: string; readonly advisory: string }[] };
  const pins = groundTruth.lockfilePins;
  assert.ok(pins.length >= 3, "ground truth must pin >= 3 advisories per spec 13 §8.2");
  const lockfilePackages = new Set(pins.map((p) => p.package));

  const { report } = await runDeps(join(FIXTURE_DIR, "v96.hbc"), { sigdb: join(FIXTURE_DIR, "sigdb"), noSharedDb: true, offline: true });
  const slice = loadOsvSlice(); // network-free: committed slice, never live-queried
  const matches = matchOsv(report, slice);

  const claimMatches = matches.filter((m) => m.tier === "claim");
  for (const pin of pins) {
    assert.ok(
      claimMatches.some((m) => m.package === pin.package && m.advisory.id === pin.advisory),
      `expected a claim-tier match for ${pin.package}@${pin.version} -> ${pin.advisory}`,
    );
  }
  const offLockfileClaims = claimMatches.filter((m) => !lockfilePackages.has(m.package));
  assert.equal(offLockfileClaims.length, 0, `0 claim-tier findings must name a package absent from the fixture lockfile, got: ${offLockfileClaims.map((m) => m.package).join(",")}`);

  for (const m of claimMatches) {
    assert.match(m.claim, /^vulnerable dependency:/, "claim tier is unprefixed per spec 13 §13 ruling 2 (no candidate: prefix)");
  }
});
