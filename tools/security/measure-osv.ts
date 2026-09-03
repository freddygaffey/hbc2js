#!/usr/bin/env node
// tools/security/measure-osv.ts — spec 13 (P2.4 reuse-validation) §8.2's
// Decision-8 quadruple for Lane O: known-advisory recall / false-attribution
// count at claim tier / method (this script) / held-out (Expensify closure
// containment, honest-skip if the bundle isn't fetched locally, ruling R-O).
//
// Runs: `hbc2js deps` (`src/deps/index.ts`'s `runDeps`) over the vuln-app
// fixture with its project-local sigdb (`tools/security/build-vulnapp-
// sigdb.ts`'s output, `--offline --no-shared-db`) -> the two-key gate
// (`src/security/osv-gate.ts`) -> the committed offline OSV slice match
// (`src/security/osv-adapter.ts`) -> writes findings through
// `OsvService`/`FindingStore` into a scratch project dir (never committed)
// -> compares against `ground-truth.json`'s `lockfilePins`.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDeps } from "../../src/deps/index.ts";
import { loadOsvSlice, matchOsv, readDemotionState, OsvService, DEFAULT_OSV_DB_PATH } from "../../src/security/osv-adapter.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "security", "vuln-app");

interface LockfilePin {
  readonly package: string;
  readonly version: string;
  readonly advisory: string;
}

async function measureFixture(): Promise<{ readonly recall: number; readonly claimFindings: number; readonly offLockfileClaims: number; readonly candidateMisattributions: number; readonly pass: boolean }> {
  const groundTruth = JSON.parse(readFileSync(join(FIXTURE_DIR, "ground-truth.json"), "utf8")) as { readonly lockfilePins: readonly LockfilePin[] };
  const pins = groundTruth.lockfilePins;
  const lockfilePackages = new Set(pins.map((p) => p.package));

  const { report } = await runDeps(join(FIXTURE_DIR, "v96.hbc"), { sigdb: join(FIXTURE_DIR, "sigdb"), noSharedDb: true, offline: true });
  const slice = loadOsvSlice();
  const demotionState = readDemotionState();
  const matches = matchOsv(report, slice, { demotionState });

  const reportHash = createHash("sha256").update(JSON.stringify(report)).digest("hex").slice(0, 8);
  const scratchDir = mkdtempSync(join(tmpdir(), "hbc2js-osv-measure-"));
  try {
    const svc = new OsvService({ projectDir: scratchDir });
    svc.writeMatches(matches, report, { dbDate: slice._retrieved, runId: `measure-osv:${Date.now()}`, reportHash });

    const claimMatches = matches.filter((m) => m.tier === "claim");
    const candidateMatches = matches.filter((m) => m.tier === "candidate");

    const recalledPins = pins.filter((pin) => claimMatches.some((m) => m.package === pin.package && m.advisory.id === pin.advisory));
    const recall = pins.length === 0 ? 1 : recalledPins.length / pins.length;
    const offLockfileClaims = claimMatches.filter((m) => !lockfilePackages.has(m.package)).length;
    const candidateMisattributions = candidateMatches.filter((m) => !lockfilePackages.has(m.package)).length;

    return { recall, claimFindings: claimMatches.length, offLockfileClaims, candidateMisattributions, pass: recall === 1 && offLockfileClaims === 0 };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const start = Date.now();
  const fixture = await measureFixture();
  const wallMs = Date.now() - start;

  console.log("=== Lane O (OSV) measured quadruple — spec 13 §8.2 ===");
  console.log(`metric:   known-advisory recall; false-attribution count at claim tier`);
  console.log(`target:   100% recall of the >=3 seeded pins; 0 claim-tier off-lockfile findings`);
  console.log(`method:   tools/security/measure-osv.ts`);
  console.log(`db:       ${DEFAULT_OSV_DB_PATH} (retrieved ${loadOsvSlice()._retrieved}, CC-BY 4.0)`);
  console.log("");
  console.log(`fixture:  recall=${(fixture.recall * 100).toFixed(1)}%  claim-findings=${fixture.claimFindings}  off-lockfile-claims=${fixture.offLockfileClaims}  candidate-misattributions=${fixture.candidateMisattributions}  wall=${wallMs}ms`);
  console.log(`fixture:  ${fixture.pass ? "PASS" : "FAIL"} (100% recall AND 0 off-lockfile claims required)`);
  console.log("");

  const expensifyBundle = join(REPO_ROOT, "tests", "fixtures", "bundles", "expensify-app");
  const { existsSync } = await import("node:fs");
  if (!existsSync(expensifyBundle)) {
    console.log(`held-out: SKIPPED (honest) — ${expensifyBundle} not present locally. Fetch via tests/fixtures/bundles/fetch.sh per spec 13 ruling R-O (Expensify's committed lockfile at the fetched tag is the ground-truth closure); re-run this script after fetching to get a real number.`);
  } else {
    console.log(`held-out: Expensify bundle found but the closure-containment check is not wired yet (TODO, tracked alongside the fetch) — treat as SKIPPED, not a silent pass.`);
  }

  if (!fixture.pass) process.exitCode = 1;
}

main();
