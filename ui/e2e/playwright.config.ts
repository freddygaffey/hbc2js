// ui/e2e/playwright.config.ts — Playwright smoke suite config (docs/UI.md
// "Smoke test (Playwright)"). Two modes, selected by env vars set by the
// npm scripts in ui/package.json:
//
//   npm run e2e       — PW_BASE_URL unset: starts our OWN ui-server
//                        (:7341, API only) + `vite preview` (:7342, the
//                        static shell built by prepare-fixture.mjs into a
//                        throwaway dist — never the shared ui/dist/ the
//                        live NSW rig's :4173 preview serves) over a
//                        throwaway project (prepare-fixture.mjs). Runs the
//                        write (rename) test.
//   npm run e2e:nsw    — PW_BASE_URL=http://127.0.0.1:4173, PW_READONLY=1:
//                        no webServer entries at all — points at Fred's
//                        already-running rig (:4173 / :7331) read-only,
//                        never restarts it, skips the rename test.
import { defineConfig, devices } from "@playwright/test";
import { API_PORT, DIST_DIR, PREVIEW_PORT, PROJECT_DIR } from "./prepare-fixture.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const uiDir = join(__dirname, "..");

const baseURL = process.env["PW_BASE_URL"] ?? `http://127.0.0.1:${PREVIEW_PORT}`;
const usingFixture = process.env["PW_BASE_URL"] === undefined;

export default defineConfig({
  testDir: __dirname,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  // The live NSW rig (4,510 modules) can take up to ~70s to answer
  // /api/segregation on a loaded box (docs/UI.md); give each test enough
  // room to wait that out rather than timing the whole test out first.
  timeout: usingFixture ? 30_000 : 150_000,
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(usingFixture
    ? {
        webServer: [
          {
            command: `node ${join(repoRoot, "src/cli.ts")} ui-server ${PROJECT_DIR} --port ${API_PORT}`,
            url: `http://127.0.0.1:${API_PORT}/api/segregation`,
            reuseExistingServer: false,
            timeout: 30_000,
          },
          {
            command: `npx vite preview --outDir ${DIST_DIR} --port ${PREVIEW_PORT} --strictPort`,
            cwd: uiDir,
            url: `http://127.0.0.1:${PREVIEW_PORT}`,
            reuseExistingServer: false,
            timeout: 30_000,
          },
        ],
      }
    : {}),
});
