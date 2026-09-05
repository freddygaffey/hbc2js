// tests/gate/ui/e2e-smoke.test.ts — runs the Playwright smoke suite
// (ui/e2e/) as a real gate, not a cheap existence check: 19 specs used to
// exist without ever running in `npm run test:gate` or CI, so unit tests on
// both halves (ui/src, src/ui-server) passed while the wire between them
// went unread (docs/AGENT-LOG.md 2026-09-05, e2e-gate task: Fred found the
// rename dialog opens but "doesn't actually rename anything" from a
// rudimentary manual pass — exactly the escape this closes).
//
// Skips (t.skip, not a silent pass) ONLY when Playwright's own Chromium
// build is not installed under its cache dir — e.g. a Linux CI image that
// never ran `npx playwright install chromium` — so this file adds zero risk
// to a node/browser-less run; everywhere the browser is present (this repo's
// dev machines, and any CI job that adds the install step per docs/UI.md),
// a red suite fails the gate for real.
//
// Isolated port base + throwaway root (ui/e2e/prepare-fixture.mjs's own
// concurrency knobs) so this test running inside two agents' `npm run
// test:gate` at once, or alongside a human's interactive `cd ui && npm run
// e2e`, does not collide on :7341/:7342 or the default throwaway tmp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "../../support/paths.ts";

const ui = (...p: string[]): string => join(repoRoot(), "ui", ...p);

/** Playwright's browser cache dir differs by platform; `PLAYWRIGHT_BROWSERS_PATH`
 *  overrides it on either. A missing/empty dir, or one with no `chromium-*`
 *  entry, means `npx playwright install chromium` was never run here. */
function chromiumInstalled(): boolean {
  const dir =
    process.env["PLAYWRIGHT_BROWSERS_PATH"] ??
    (process.platform === "darwin" ? join(homedir(), "Library", "Caches", "ms-playwright") : join(homedir(), ".cache", "ms-playwright"));
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((e) => e.startsWith("chromium-"));
  } catch {
    return false;
  }
}

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

test(
  "the Playwright smoke suite (cd ui && npm run e2e) is actually green",
  { timeout: 6 * 60_000, skip: chromiumInstalled() ? false : "Playwright's Chromium is not installed under its cache dir (run `npx playwright install chromium` in ui/) — this environment cannot run a real browser" },
  () => {
    // A port/root distinct from every documented default (7341/7342, the
    // NSW rig's 4173/7331) and from every other concurrent caller of this
    // same file, best-effort via pid — collisions are still possible under
    // heavy concurrent-agent load, same as any other shared-box port choice
    // in this repo (docs/UI.md's own note on HBC2JS_E2E_PORT_BASE).
    const portBase = 7400 + (process.pid % 190);
    const root = join(tmpdir(), `hbc2js-ui-e2e-gate-${process.pid}`);
    const r = spawnSync("npm", ["run", "e2e"], {
      cwd: ui(),
      encoding: "utf8",
      shell: false,
      env: { ...process.env, HBC2JS_E2E_PORT_BASE: String(portBase), HBC2JS_E2E_ROOT: root },
    });
    const tail = (s: string): string => s.slice(Math.max(0, s.length - 4000));
    assert.equal(
      r.status,
      0,
      `ui/e2e Playwright suite failed (exit ${String(r.status)}); last output:\n${tail((r.stdout ?? "") + (r.stderr ?? ""))}`,
    );
  },
);
