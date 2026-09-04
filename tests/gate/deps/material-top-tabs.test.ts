// tests/gate/deps/material-top-tabs.test.ts — docs/BUGS.md row "tools/pkgsig/db
// (signature DB) — no @react-navigation/material-top-tabs coverage"
// (dated 2026-09-02, follow-up to the P-10 segregation fix).
//
// `tools/pkgsig/db` now carries a `@react-navigation/material-top-tabs@8.0.0-
// alpha.49__hbc98.json` signature (the exact version react-navigation-
// example-0.85.3's own `deps-truth.json` test-only ground truth records),
// confirmed against this real fixture the same way `confirmCandidates`
// (`src/deps/confirm.ts`) is driven from `hbc2js deps --confirm` — a
// scratch RN 0.85.3 project, the published npm package installed with its
// own real dependency tree (`--ignore-scripts` throughout), Metro-bundled,
// compiled with `tools/hermesc/v98`, fingerprinted, baseline-subtracted
// against this DB's own hbc98 baselines, and matched: high tier (19
// module-exact hits, 449 function-exact hits). This test pins that
// `runDeps --offline` on the real fixture now confirms the package.
//
// NOT proven here (and not true, measured directly): that module 1611 (the
// fixture's own material-top-tabs barrel/index) moves to `node_modules/
// @react-navigation/material-top-tabs/` in segregation. Checked directly —
// every one of this fixture's own material-top-tabs-sourced module ids
// (1611, 1612, 1613, 1615, 1616, 1618-1623, per the fixture's `.map`
// `sources` entries under `/packages/material-top-tabs/src/...`) has ZERO
// exact or fuzzy-hash hits against this new signature, despite the
// package reaching "high" tier overall — that tier comes entirely from
// code material-top-tabs shares with `@react-navigation/elements`/`core`
// (also present in the already-confirmed `native`/`stack` signatures),
// never from material-top-tabs's own code. Root cause, confirmed via the
// bundle's own source map: react-navigation-example builds `@react-
// navigation/*` from the react-navigation monorepo's own workspace source
// (`/packages/material-top-tabs/src/index.tsx`), not the published npm
// tarball this signature was fingerprinted from — genuine build-provenance
// divergence a hash-based signature cannot bridge, not a version-pinning
// mistake (the version pinned here, 8.0.0-alpha.49, is exactly this
// fixture's own ground-truth version). `tests/gate/split/segregate.test.ts`'s
// pinned 3/50 (WITH deps) counts are therefore correctly unchanged by this
// signature addition — see docs/BUGS.md's updated row for the narrower
// follow-up this leaves open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { runDeps } from "../../../src/deps/index.ts";

const REACT_NAV_EXAMPLE = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.hbc");

void test("deps: @react-navigation/material-top-tabs is confirmed offline on react-navigation-example-0.85.3", async (t) => {
  if (!existsSync(REACT_NAV_EXAMPLE)) {
    t.skip("react-navigation-example-0.85.3 not fetched (run tests/fixtures/bundles/react-navigation-example-0.85.3/fetch.sh)");
    return;
  }
  const run = await runDeps(REACT_NAV_EXAMPLE, { offline: true });
  const confirmedPackages = run.report.confirmedDeps.map((d) => d.package);
  assert.ok(
    confirmedPackages.includes("@react-navigation/material-top-tabs"),
    `expected @react-navigation/material-top-tabs in confirmedDeps, got: ${confirmedPackages.join(", ")}`,
  );

  // The signature does NOT give any of the fixture's own material-top-tabs
  // module ids a confirmed per-module owner (see file header) — pinned so
  // a future signature-DB change that DOES bridge this gap is visible here
  // rather than silently changing segregation counts with no test noticing.
  const moduleIds = [1611, 1612, 1613, 1615, 1616, 1618, 1619, 1620, 1621, 1622, 1623];
  const ownedIds = run.report.moduleOwnership.filter((o) => o.localModuleId !== null && moduleIds.includes(o.localModuleId)).map((o) => o.localModuleId);
  assert.deepEqual(ownedIds, [], `expected none of this fixture's own material-top-tabs module ids to have a confirmed owner yet, got: ${ownedIds.join(", ")}`);
});
