// ui/e2e/perf.spec.ts — first-paint budget + a "no 4xx on load" guard
// (UI bur 1, docs/reports/2026-09-05-ui-first-paint.md).
//
// Why this exists: a refresh against the live Service NSW rig showed
// NOTHING for 42 s. The cause was not rendering but head-of-line blocking
// in a single-threaded Node server — `GET /api/leads` (a whole-bundle scan,
// 37.7 s cold) was fired on mount by the left pane even though the Leads
// tab was not open, and every other request the shell made queued behind
// it; `GET /api/modules` added 3.15 s of its own by materialising every
// index to return one of them. Both are fixed (`src/ui-server/list.ts`,
// `ui/src/panes/LeftPane.tsx`); this test is the regression.
//
// Runs against the throwaway fixture server the rest of the suite uses
// (`ui/e2e/playwright.config.ts`, ports from HBC2JS_E2E_PORT_BASE) — never
// the owner's live :7331/:4173. Read-only: it loads the page and clicks
// nothing.
import { test, expect, type Request } from "@playwright/test";

const AGAINST_RIG = process.env["PW_BASE_URL"] !== undefined;

/** The budget, justified: the fixture project (435 modules) answers
 *  `/api/modules` in single-digit milliseconds and `/api/segregation` from
 *  a warm cache, so the honest number is well under a second. This box runs
 *  up to five agents at once, and CI/dev machines vary wildly, so the
 *  assertion is set an order of magnitude above the honest number: it is
 *  here to catch "the shell blocks on a whole-bundle scan again" (tens of
 *  seconds), not to police jitter. Against the live NSW rig (`e2e:nsw`) the
 *  same budget is relaxed for a 12 MB bundle on a loaded box. */
const FIRST_PAINT_MS = AGAINST_RIG ? 20_000 : 10_000;

test.describe("first paint", () => {
  test("module tree and function rows appear within the budget", async ({ page }) => {
    const started = Date.now();
    await page.goto("/");
    await expect(page.getByRole("tree", { name: "module tree" })).toBeVisible({ timeout: FIRST_PAINT_MS });
    const treeMs = Date.now() - started;
    // A tree with rows in it, not just the empty container: the left pane
    // auto-opens the first module, so a function row is the real "the
    // analyst can see the app" signal.
    await expect(page.locator("[data-module]").first()).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.locator("[data-fn]").first()).toBeVisible({ timeout: FIRST_PAINT_MS });
    const rowsMs = Date.now() - started;
    expect(treeMs, `module tree visible in ${treeMs}ms`).toBeLessThan(FIRST_PAINT_MS);
    expect(rowsMs, `function rows visible in ${rowsMs}ms`).toBeLessThan(FIRST_PAINT_MS);
  });

  test("no request on load asks for the leads scan", async ({ page }) => {
    const paths: string[] = [];
    page.on("request", (req: Request) => {
      const u = new URL(req.url());
      if (u.pathname.startsWith("/api/")) paths.push(u.pathname);
    });
    await page.goto("/");
    await expect(page.locator("[data-module]").first()).toBeVisible({ timeout: FIRST_PAINT_MS });
    await page.waitForTimeout(1500);
    // `/api/leads` belongs to the Leads tab, which is not the tab a fresh
    // shell shows. Fetching it on mount is what blocked every other route.
    expect(paths.filter((p) => p.startsWith("/api/leads"))).toEqual([]);
    // …and the tree still got what it does need.
    expect(paths).toContain("/api/modules");
  });

  test("no request on load returns 4xx", async ({ page }) => {
    const bad: string[] = [];
    page.on("response", (res) => {
      const status = res.status();
      if (status >= 400 && status < 500) bad.push(`${status} ${res.url()}`);
    });
    await page.goto("/");
    await expect(page.locator("[data-module]").first()).toBeVisible({ timeout: FIRST_PAINT_MS });
    await page.waitForTimeout(1500);
    expect(bad, `4xx responses during load:\n${bad.join("\n")}`).toEqual([]);
  });
});
