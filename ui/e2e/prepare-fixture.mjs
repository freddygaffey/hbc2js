#!/usr/bin/env node
// ui/e2e/prepare-fixture.mjs — builds a throwaway hbc2js project + a
// throwaway ui/dist so the Playwright smoke suite (ui/e2e/smoke.spec.ts)
// can run against a real server on its own port (7341/7342), never touching
// the shared ui/dist/ that the live NSW rig's vite preview (:4173) serves.
// Run before `playwright test`; `npm run e2e` does both.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDir = join(__dirname, "..");
const repoRoot = join(uiDir, "..");

export const FIXTURE_ROOT = join(tmpdir(), "hbc2js-ui-e2e");
export const PROJECT_DIR = join(FIXTURE_ROOT, "proj");
export const DIST_DIR = join(FIXTURE_ROOT, "dist");
export const API_PORT = 7341;
export const PREVIEW_PORT = 7342;

export const BUNDLE = join(repoRoot, "tests/fixtures/bundles/rn-template-0.72/index.android.hbc");

function main() {
  if (!existsSync(BUNDLE)) {
    throw new Error(`fixture bundle missing: ${BUNDLE} — run tests/fixtures/build.sh or fetch.sh first`);
  }
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  mkdirSync(FIXTURE_ROOT, { recursive: true });

  execFileSync("node", [join(repoRoot, "src/cli.ts"), "init", BUNDLE, "--out", PROJECT_DIR], { stdio: "inherit" });

  execFileSync("npx", ["vite", "build", "--outDir", DIST_DIR], {
    cwd: uiDir,
    stdio: "inherit",
    env: { ...process.env, VITE_API_MOCK: "0", VITE_API_BASE: `http://127.0.0.1:${API_PORT}` },
  });
}

// Only run when invoked directly (`node prepare-fixture.mjs`), not when
// playwright.config.ts imports the constants above.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
