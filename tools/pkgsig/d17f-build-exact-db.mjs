#!/usr/bin/env node
// tools/pkgsig/d17f-build-exact-db.mjs — D17f proof-of-concept (docs/
// DECISIONS.md D17f, docs/DEPS.md "D17f proof"): fingerprints ONE app's
// (tests/fixtures/bundles/react-navigation-example-0.85.3/) real
// dependencies at the EXACT versions that app ships, into a scratch sigdb,
// so `hbc2js deps` can be scored with that DB layered on top of the shared
// starter set. Reuses `src/deps/confirm.ts`'s `confirmCandidates` — the
// same single-package builder `hbc2js deps --confirm` uses — rather than
// the heavier `tools/pkgsig/bulk/build-one.mjs` pipeline (which needs a
// pre-cloned, pre-`npm install`ed 16-slot RN scaffold pool set up by
// `tools/pkgsig/bulk/run.sh setup`; this task doesn't have one and doesn't
// need one — `confirmCandidates` bootstraps its own single scratch RN
// project on first use). Confirming against the app's own module inventory
// (rather than writing signatures unconditionally) is deliberate: a
// candidate that doesn't clear medium/high tier against this exact target
// genuinely isn't distinguishably present in the bundle (e.g.
// `@react-navigation/devtools`, a dev-only package Metro strips from a
// production build — see docs/DEPS.md).
//
// Versions below are exact, not ranges: the 7 already-`^`/`~`-pinned deps
// (react-native-gesture-handler, -reanimated, -safe-area-context, -screens,
// react-native-worklets, @react-native-async-storage/async-storage) were
// read from react-navigation/react-navigation's pnpm-lock.yaml at commit
// ab1319d (resolved, not the caret range in package.json); the
// @react-navigation/* + react-native-drawer-layout + react-native-tab-view
// workspace packages' versions come straight from
// tests/fixtures/bundles/react-navigation-example-0.85.3/deps-truth.json
// (D17d ground truth, derived from each package's own package.json next to
// its source in the monorepo). Both are independently checked against the
// npm registry (`npm view <pkg>@<version> version`) before use here.
//
// Usage: node tools/pkgsig/d17f-build-exact-db.mjs [scratchDir]
//   scratchDir defaults to /tmp/hbc2js-d17f-proof (never under the repo —
//   this writes an RN scaffold + node_modules, ~200MB, never to be
//   committed per this task's brief).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInventory } from "../../src/deps/inventory.ts";
import { confirmCandidates } from "../../src/deps/confirm.ts";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");
const FIXTURE = join(REPO, "tests/fixtures/bundles/react-navigation-example-0.85.3");
const HBC = join(FIXTURE, "react-navigation-example.hbc");
const SCRATCH = process.argv[2] ?? "/tmp/hbc2js-d17f-proof";
// Optional 3rd arg: run only this one package (npm's own --no-save installs
// against a shared scratch project were observed to race when several
// candidates run back-to-back in one Node process — see docs/DEPS.md "D17f
// proof"; running one candidate per fresh `node` process, sequentially from
// a shell loop, sidesteps it without touching src/deps/confirm.ts).
const ONLY_PACKAGE = process.argv[3];

// Already fingerprinted at these exact versions in the shared DB
// (tools/pkgsig/db/) from earlier work — skip, no need to rebuild.
const ALREADY_IN_SHARED_DB = new Set([
  "react-native-gesture-handler", // @3.0.2
  "react-native-reanimated", // @4.5.3
  "react-native-safe-area-context", // @5.7.0
  "react-native-screens", // @4.26.2
  "@react-native-async-storage/async-storage", // @2.2.0
  "@react-navigation/native", // @8.0.0-alpha.44
  "@react-navigation/stack", // @8.0.0-alpha.53
]);

const CANDIDATES = [
  { package: "react-native-worklets", version: "0.11.3" },
  { package: "@react-navigation/core", version: "8.0.0-alpha.34" },
  { package: "@react-navigation/routers", version: "8.0.0-alpha.17" },
  { package: "@react-navigation/elements", version: "3.0.0-alpha.48" },
  { package: "@react-navigation/drawer", version: "8.0.0-alpha.51" },
  { package: "@react-navigation/devtools", version: "8.0.0-alpha.35" },
  { package: "@react-navigation/bottom-tabs", version: "8.0.0-alpha.50" },
  { package: "@react-navigation/native-stack", version: "8.0.0-alpha.52" },
  { package: "@react-navigation/material-top-tabs", version: "8.0.0-alpha.49" },
  { package: "react-native-drawer-layout", version: "5.0.0-alpha.18" },
  { package: "react-native-tab-view", version: "5.0.0-alpha.15" },
].filter((c) => !ALREADY_IN_SHARED_DB.has(c.package)).filter((c) => ONLY_PACKAGE === undefined || c.package === ONLY_PACKAGE);

async function main() {
  const bytes = new Uint8Array(readFileSync(HBC));
  const { inventory } = buildInventory(bytes);

  const results = await confirmCandidates(CANDIDATES, inventory, {
    scratchProjectDir: join(SCRATCH, "rn-scaffold"),
    rnVersion: "0.85.3",
    hbcVersion: 98,
    hermescPath: join(REPO, "tools/hermesc/v98/hermesc"),
    projectDbDir: join(SCRATCH, "sigdb"),
    userCacheDbDir: join(SCRATCH, "usercache-unused"),
    baselineDirs: [join(REPO, "tools/pkgsig/db")],
    referenceDate: "2026-08-26T00:00:00Z", // react-navigation-example fixture commit date (BUILD.md)
    rateLimitMs: 200,
    onProgress: (m) => process.stderr.write(`[${new Date().toISOString()}] ${m}\n`),
  });

  console.log(JSON.stringify(results.map((r) => ({ package: r.candidate.package, version: r.candidate.version, ok: r.ok, ...(r.ok ? { tier: r.score.tier } : { reason: r.reason }) })), null, 2));
  process.stderr.write(`\nWrote ${results.filter((r) => r.ok).length}/${results.length} signatures to ${join(SCRATCH, "sigdb")}\n`);
  process.stderr.write(`Also copy the 7 ALREADY_IN_SHARED_DB files listed above from tools/pkgsig/db/ into that sigdb dir before scoring with d17f-score.mjs, to get the full 17-package exact-version layer.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
