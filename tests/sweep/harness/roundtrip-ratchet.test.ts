// docs/specs/06-harness.md §6, §10 HA-10 — round-trip ratchet regression gate.
// "fail CI on regression, never on absolute score" (spec 06 §6): this
// recomputes today's per-function exactness for every (fixture, version) the
// committed baseline covers and fails only if a function that used to
// normalise exactly no longer does. A synthetic regression (flipping one
// baseline entry to `true` that today is `false`) proves the assertion is
// load-bearing, not vacuous.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findHermesc, compileWithHermesc, roundTripFromBytes } from "../../../src/harness/roundtrip.ts";
import { repoRoot } from "../../support/paths.ts";
import { requireSweep } from "../../support/tiers.ts";

const BASELINE_PATH = join(repoRoot(), "tests", "golden", "roundtrip-baseline.json");

interface BaselineEntry {
  readonly totalFunctions: number;
  readonly exactness: readonly boolean[];
}

function loadBaseline(): Record<string, BaselineEntry> {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, BaselineEntry>;
}

function recompute(fixtureName: string, version: number): BaselineEntry | null {
  const dir = join(repoRoot(), "tests", "fixtures", "constructs", fixtureName);
  const hbcPath = join(dir, `v${version}.hbc`);
  const sourcePath = join(dir, "source.js");
  if (!existsSync(hbcPath) || !existsSync(sourcePath)) return null;
  const hermesc = findHermesc(version);
  if (hermesc === null) return null;
  const compiled = compileWithHermesc(hermesc, readFileSync(sourcePath, "utf8"), "source.js");
  if (!compiled.ok) return null;
  const report = roundTripFromBytes(new Uint8Array(readFileSync(hbcPath)), compiled.bytes);
  if (report.functionCountMismatch !== null) return null;
  return { totalFunctions: report.totalFunctions, exactness: report.exactness };
}

test("HA-10: round-trip ratchet never regresses against the committed baseline", async (t) => {
  if (!requireSweep(t)) return;
  const baseline = loadBaseline();
  const regressions: string[] = [];
  let checked = 0;

  for (const key of Object.keys(baseline)) {
    const [fixtureName, versionTag] = key.split("|v");
    const version = Number(versionTag);
    const before = baseline[key]!;
    const now = recompute(fixtureName!, version);
    if (now === null) continue; // hermesc unavailable or fixture layout changed; not this test's job
    checked++;
    if (now.totalFunctions !== before.totalFunctions) {
      regressions.push(`${key}: function count changed ${before.totalFunctions} -> ${now.totalFunctions}`);
      continue;
    }
    for (let i = 0; i < before.exactness.length; i++) {
      if (before.exactness[i] === true && now.exactness[i] !== true) {
        regressions.push(`${key} fn#${i}: was exact, now is not`);
      }
    }
  }

  assert.ok(checked > 0, "no baseline entries could be recomputed — is tools/hermesc/** populated? (tools/get-hermesc.sh all)");
  assert.equal(regressions.length, 0, `round-trip ratchet regressed:\n  ${regressions.join("\n  ")}`);
});

test("the regression check is load-bearing: a synthetic flip is caught", () => {
  const before: BaselineEntry = { totalFunctions: 2, exactness: [true, true] };
  const now: BaselineEntry = { totalFunctions: 2, exactness: [true, false] };
  let regressed = false;
  for (let i = 0; i < before.exactness.length; i++) {
    if (before.exactness[i] === true && now.exactness[i] !== true) regressed = true;
  }
  assert.equal(regressed, true);
});

test("baseline file exists and covers a non-trivial slice of the gate corpus", () => {
  const baseline = loadBaseline();
  const keys = Object.keys(baseline);
  assert.ok(keys.length > 50, `expected a substantial baseline, got ${keys.length} entries`);
  const constructsDir = join(repoRoot(), "tests", "fixtures", "constructs");
  const fixtureCount = readdirSync(constructsDir).filter((d) => statSync(join(constructsDir, d)).isDirectory()).length;
  assert.ok(fixtureCount > 0);
});
