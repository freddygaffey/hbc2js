// docs/DECISIONS.md D17a point 1 — module inventory: enumerate Metro
// `__d(fn, id, deps)` registrations structurally (dscan.ts), never by
// decompiling everything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { repoRoot } from "../../support/paths.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

test("buildInventory recovers rn-template-0.72's full __d() module graph", () => {
  const bytes = readFileSync(RN_TEMPLATE);
  const { inventory } = buildInventory(bytes);

  assert.equal(inventory.hbcVersion, 94);
  // docs/PACKAGE-SIGNATURES.md §5.6: 435 Metro modules in this exact fixture.
  assert.equal(inventory.modules.length, 435);
  assert.ok(inventory.totalFunctions > inventory.modules.length, "expects nested closures beyond one function per module");
  assert.ok(inventory.moduledFunctionCount > 0);
  assert.ok(inventory.moduledFunctionCount <= inventory.totalFunctions);

  // Every module has a resolved local id and a real (non-negative) dep count
  // for this fixture — Metro always emits a static deps array here.
  for (const m of inventory.modules) {
    assert.notEqual(m.localModuleId, null, `module at factory fn ${m.factoryFunctionIndex} has no resolved local id`);
    assert.notEqual(m.depCount, null, `module ${m.localModuleId} has no resolved dep count`);
  }

  // At least one module's function set carries real string-constant evidence
  // (guess.ts and report.ts both depend on this being populated).
  const withStrings = inventory.modules.filter((m) => m.stringConstants.length > 0);
  assert.ok(withStrings.length > 100, `expected most of 435 modules to carry string constants, got ${withStrings.length}`);

  // Dependency edges are real Metro module ids, not function indices — every
  // id referenced should itself be some module's own localModuleId (Metro
  // never leaves a dangling reference in a real bundle).
  const knownIds = new Set(inventory.modules.map((m) => m.localModuleId));
  let sawNonEmptyDeps = false;
  for (const m of inventory.modules) {
    for (const dep of m.depIds ?? []) {
      sawNonEmptyDeps = true;
      assert.ok(knownIds.has(dep), `module ${m.localModuleId} depends on unknown module id ${dep}`);
    }
  }
  assert.ok(sawNonEmptyDeps, "expected at least one module with a non-empty deps array");
});

test("buildInventory is deterministic across repeated calls", () => {
  const bytes = readFileSync(RN_TEMPLATE);
  const a = buildInventory(bytes).inventory;
  const b = buildInventory(bytes).inventory;
  assert.deepEqual(
    a.modules.map((m) => m.exactHash),
    b.modules.map((m) => m.exactHash),
  );
});
