// tests/gate/ui/e2e-smoke.test.ts — cheap existence check for the
// Playwright smoke suite (ui/e2e/): no browser is launched here, this only
// asserts the suite exists and is wired up, so the root gate stays fast and
// dependency-free. The suite itself is run separately: `cd ui && npm run
// e2e` (fixture) / `npm run e2e:nsw` (read-only against the live rig), both
// documented in docs/UI.md "Smoke test (Playwright)".
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const ui = (...p: string[]): string => join(repoRoot(), "ui", ...p);

test("ui/e2e/ exists with a Playwright config and a spec file", () => {
  assert.ok(existsSync(ui("e2e")), "ui/e2e/ must exist");
  assert.ok(existsSync(ui("e2e", "playwright.config.ts")), "ui/e2e/playwright.config.ts must exist");
  assert.ok(existsSync(ui("e2e", "smoke.spec.ts")), "ui/e2e/smoke.spec.ts must exist");
});

test("ui/package.json has e2e and e2e:nsw scripts and @playwright/test pinned exact", () => {
  const pkg = JSON.parse(readFileSync(ui("package.json"), "utf8")) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.ok(pkg.scripts?.e2e?.includes("playwright test"), "ui/package.json must have an `e2e` script running playwright test");
  assert.ok(pkg.scripts?.["e2e:nsw"]?.includes("playwright test"), "ui/package.json must have an `e2e:nsw` script running playwright test");
  const pinned = pkg.devDependencies?.["@playwright/test"];
  assert.ok(pinned !== undefined && /^\d/.test(pinned), "@playwright/test must be pinned to an exact version, not a range");
});
