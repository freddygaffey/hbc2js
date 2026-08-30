// docs/DECISIONS.md D17a/D17b/D17d — exercises `hbc2js deps --confirm`
// end-to-end (real network: npm registry search/metadata/pack, a real
// `react-native` scratch install, real Metro bundling, real `hermesc`)
// against `react-navigation-example-0.85.3` with an empty project-local
// sigdb and `--no-shared-db`, so every dependency this recovers had to come
// from the guess+confirm pipeline alone, never a pre-built signature.
// INCONCLUSIVE-via-skip (not a failure) when the sweep tier isn't
// requested, the fixture's `.hbc`/`deps-truth.json` aren't present locally
// (run its `fetch.sh` first), or there's no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { requireSweep } from "../../support/tiers.ts";
// @ts-expect-error — plain-JS tool, no declaration file.
import { scoreAgainstTruth, formatScore } from "../../../tools/deps-truth.mjs";

const DIR = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3");

test("react-navigation-example-0.85.3: hbc2js deps --confirm, --no-shared-db, empty project DB — confirmed-tier precision", async (t) => {
  if (!requireSweep(t)) return;
  const hbcPath = join(DIR, "react-navigation-example.hbc");
  const truthPath = join(DIR, "deps-truth.json");
  if (!existsSync(hbcPath) || !existsSync(truthPath)) {
    t.skip(`${hbcPath} or ${truthPath} not present — run this fixture's fetch.sh first (INCONCLUSIVE, not a failure)`);
    return;
  }

  // A fresh scratch `--out` per run: an empty project-local sigdb (D17a
  // "every candidate must be confirmed via npm"), and where the confirm
  // stage's own scratch RN project / npm tarball cache live — never the
  // repo, never `~/.cache/hbc2js/sigdb` (this test does write there, same
  // as a real `--confirm` run would, so it's free on a second run; that's
  // the point of D17b's user-cache layer, not something to work around).
  const out = mkdtempSync(join(tmpdir(), "hbc2js-sweep-confirm-out-"));
  try {
    const truth = JSON.parse(readFileSync(truthPath, "utf8"));
    const s = await scoreAgainstTruth(hbcPath, truth, { confirm: true, offline: false, noSharedDb: true, out });
    console.log(formatScore(s));
    console.log(`[deps sweep --confirm] confirmed: ${s.confirmed.reported.join(", ") || "none"}`);

    assert.deepEqual(s.confirmed.falsePositives, [], "D17d gate: zero confirmed-tier false positives, guess+confirm alone");
    // Not hard-gated at 9/9: two of this fixture's nine known dependencies
    // (@react-navigation/native, /stack) are this exact monorepo's own
    // workspace-linked sibling packages, not installed from the npm
    // registry at all (BUILD.md's "Workspace-package caveat") — their
    // compiled code is this repo's own unreleased/dev-branch source, which
    // a real `npm pack @react-navigation/{native,stack}@<any published
    // version>` is not guaranteed to byte/fuzzy-match. `/native` has
    // reached "confirmed" here before (a `reactnavigation.org` doc-link
    // host is real, surviving-release evidence, and its closest npm alpha
    // release apparently was cut from a nearby commit), but this is
    // measured, not asserted — recall is reported, not gated, same as
    // guessed/hinted tier precision elsewhere in this tool.
    assert.ok(s.confirmed.reported.length >= 5, `expected at least the five native-module-evidenced dependencies (gesture-handler, reanimated, screens, safe-area-context, pager-view) to confirm; got ${s.confirmed.reported.join(", ") || "none"}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
