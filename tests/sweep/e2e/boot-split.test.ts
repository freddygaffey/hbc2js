// docs/e2e/STAGE3-FEASIBILITY.md's "recommended first milestone": rn-template's
// __r(entry) runs under bare Node (no react-native-web, no jsdom) to
// AppRegistry.registerComponent being observed. tools/e2e/boot-split.mjs
// (the hardened version of §f's spike) drives this; this test spawns it
// against the committed rn-template-0.72 bundle and pins the floor recorded
// in tools/e2e/boot-expected/rn-template-0.72.json -- a regression is a drop
// in modulesExecuted or losing registerComponent, never a change in the
// native-access list (new native accesses are reported, not failed on: the
// native surface is expected to grow as more of the app runs).
//
// Sweep tier: splits + boots a whole 435-module bundle in a child process,
// well over the gate's budget (docs/TESTING.md "E2E tier 1"-style cost).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { requireSweep, timeScale } from "../../support/tiers.ts";

const BUNDLE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const HARNESS = join(repoRoot(), "tools", "e2e", "boot-split.mjs");
const EXPECTED_PATH = join(repoRoot(), "tools", "e2e", "boot-expected", "rn-template-0.72.json");

interface BootResult {
  readonly modulesExecuted: number;
  readonly total: number;
  readonly reachedRegisterComponent: boolean;
  readonly componentName: string | null;
  readonly firstThrow: { readonly module: number | null; readonly message: string } | null;
  readonly nativeAccesses: readonly string[];
}

interface BootExpected {
  readonly modulesExecuted: number;
  readonly total: number;
  readonly reachedRegisterComponent: boolean;
  readonly componentName: string | null;
  readonly firstThrow: { readonly module: number | null; readonly message: string } | null;
  readonly nativeAccessCount: number;
}

test(
  "E2E: rn-template-0.72's --split tree boots to AppRegistry.registerComponent under bare Node",
  { timeout: 5 * 60_000 * timeScale() },
  (t) => {
    if (!requireSweep(t)) return;
    if (!existsSync(BUNDLE)) {
      t.diagnostic(`bundle not present (${BUNDLE}) -- not checked`);
      return;
    }

    const expected = JSON.parse(readFileSync(EXPECTED_PATH, "utf8")) as BootExpected;

    const r = spawnSync(process.execPath, [HARNESS, BUNDLE, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `boot-split.mjs failed: ${r.stderr}`);
    const result = JSON.parse(r.stdout) as BootResult;

    t.diagnostic(
      `modules executed: ${result.modulesExecuted}/${result.total}; registerComponent: ${result.reachedRegisterComponent} (${result.componentName ?? "n/a"}); native accesses: ${result.nativeAccesses.length}`,
    );
    if (result.nativeAccesses.length !== expected.nativeAccessCount) {
      t.diagnostic(
        `native access count changed: pinned ${expected.nativeAccessCount}, now ${result.nativeAccesses.length} (report only, not a failure -- update tools/e2e/boot-expected/rn-template-0.72.json by hand if this is expected growth)`,
      );
    }

    // Regression guard: never boot fewer modules than the pinned floor.
    assert.ok(
      result.modulesExecuted >= expected.modulesExecuted,
      `modulesExecuted regressed: pinned floor ${expected.modulesExecuted}, got ${result.modulesExecuted}${result.firstThrow ? ` (threw in module ${result.firstThrow.module}: ${result.firstThrow.message})` : ""}`,
    );

    // If the pin says registerComponent should fire, it must still fire.
    if (expected.reachedRegisterComponent) {
      assert.equal(result.reachedRegisterComponent, true, `AppRegistry.registerComponent no longer observed (was: ${expected.componentName})`);
      assert.equal(result.componentName, expected.componentName);
    }
  },
);
