// tests/security/t1-fixture-integrity.test.ts — T1 (spec 13 §10, §9 step 1).
// Pre-impl-runnable now: ground-truth JSON lists >= 10 seed classes, each
// seed comment present in fixture source, lockfile contains the >= 3 pinned
// advisory versions, fixture .hbc decompiles through the real pipeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { decompile } from "../../src/decompile.ts";

const FIXTURE_DIR = join(repoRoot(), "tests", "fixtures", "security", "vuln-app");

interface GroundTruth {
  sourceFile: string;
  seedClasses: { id: string; description: string }[];
  lockfilePins: { package: string; version: string; advisory: string }[];
}

function readGroundTruth(): GroundTruth {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, "ground-truth.json"), "utf8")) as GroundTruth;
}

test("T1: ground-truth JSON lists >= 10 distinct seed classes", () => {
  const gt = readGroundTruth();
  const ids = new Set(gt.seedClasses.map((c) => c.id));
  assert.ok(ids.size >= 10, `expected >= 10 distinct seed classes, got ${ids.size}`);
});

test("T1: every seed class's SEED comment is present in the fixture source", () => {
  const gt = readGroundTruth();
  const source = readFileSync(join(FIXTURE_DIR, gt.sourceFile), "utf8");
  for (const c of gt.seedClasses) {
    assert.ok(source.includes(`// SEED:${c.id}`), `source is missing "// SEED:${c.id}" for class "${c.id}"`);
  }
});

test("T1: lockfile contains the >= 3 pinned advisory versions from ground truth", () => {
  const gt = readGroundTruth();
  assert.ok(gt.lockfilePins.length >= 3, `expected >= 3 lockfile pins, got ${gt.lockfilePins.length}`);
  const lockfile = JSON.parse(readFileSync(join(FIXTURE_DIR, "lockfile.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  for (const pin of gt.lockfilePins) {
    assert.equal(
      lockfile.dependencies[pin.package],
      pin.version,
      `lockfile.json must pin ${pin.package}@${pin.version} (ground truth advisory ${pin.advisory})`,
    );
  }
});

test("T1: fixture v96.hbc decompiles through the real pipeline", () => {
  const bytes = readFileSync(join(FIXTURE_DIR, "v96.hbc"));
  const result = decompile(new Uint8Array(bytes));
  assert.ok(result.module, "decompile() must produce a module");
  assert.ok(result.code.length > 0, "decompile() must produce non-empty code");
  // Sanity: every seeded function name shows up somewhere in the emitted code
  // (proves the fixture source actually made it through hermesc + hbc2js,
  // not just that decompile() didn't throw).
  const gt = readGroundTruth();
  for (const c of gt.seedClasses) {
    const fn = (c as { fn?: string | null }).fn;
    if (fn) assert.ok(result.code.includes(fn), `decompiled output missing seeded function name "${fn}"`);
  }
});
