// ui/e2e/visual.spec.ts — spec 19 §2 layer 4 / spec 26 L7's visual
// regression layer. Baselines are golden artifacts (CLAUDE.md testing
// rules, docs/CONSOLIDATION.md §B item 9): the FIRST commit of them and
// every regeneration are a Fred-approved batch (spec 26 §4.2).
//
// Every test here asserts DOM structure UNCONDITIONALLY — that half never
// flakes on a font-rendering difference between macOS and Linux CI, and
// never needs the golden-rule approval loop to stay green. The pixel
// comparison (`toHaveScreenshot`) only runs when `HBC2JS_E2E_VISUAL=1` is
// set, so CI does not fail on cross-platform font antialiasing noise by
// default; an agent regenerating/reviewing baselines sets the flag locally
// (or on whichever single box owns the baseline set) and reads the diff
// image `playwright-report/` produces on a mismatch.
//
// Runs against the throwaway fixture rig only (ui/e2e/prepare-fixture.mjs)
// — never PW_BASE_URL / Fred's live rig, so a baseline never drifts with
// whatever real bundle happens to be open on :4173.
import { test, expect, type Locator, type Page } from "@playwright/test";

test.skip(process.env["PW_BASE_URL"] !== undefined, "visual baselines run only against the throwaway fixture rig");

const WAIT = 10_000;
const PIXELS = process.env["HBC2JS_E2E_VISUAL"] === "1";

async function openFirstModuleAndFn(page: Page): Promise<Locator> {
  const firstModule = page.locator("[data-module]").first();
  await expect(firstModule).toBeVisible({ timeout: WAIT });
  const firstFn = page.locator("[data-fn]").first();
  if (!(await firstFn.isVisible().catch(() => false))) await firstModule.click();
  await expect(firstFn).toBeVisible({ timeout: WAIT });
  return firstFn;
}

/** Both default presets (bur 12's two slots), toggled via the SAME toolbar
 *  action theme.spec.ts drives — never a hand-rolled localStorage write. */
async function toggleToLight(page: Page): Promise<void> {
  const btn = page.getByTestId("theme-toggle");
  await expect(btn).toHaveAttribute("data-mode", "dark");
  await btn.click();
  await expect(btn).toHaveAttribute("data-mode", "light");
}

test.describe("visual regression (spec 26 L7)", () => {
  test("kitchen sink matches the baseline (dark)", async ({ page }) => {
    await page.goto("/?kitchen-sink");
    const sink = page.getByTestId("kitchen-sink");
    await expect(sink).toBeVisible({ timeout: WAIT });
    await expect(page.getByRole("heading", { name: "Kitchen sink" })).toBeVisible();
    await expect(page.getByTestId("sev-crit")).toBeVisible();
    if (PIXELS) await expect(page).toHaveScreenshot("kitchen-sink-dark.png");
  });

  test("kitchen sink matches the baseline (light)", async ({ page }) => {
    // The kitchen-sink route mounts inside the same ThemeProvider as the
    // shell, so the toolbar's theme toggle is not present there — the
    // light slot is set on the shell first, then carried over by
    // ThemeProvider's persisted state (same localStorage keys) when we
    // navigate to the kitchen-sink route.
    await page.goto("/");
    await expect(page.locator("[data-module]").first()).toBeVisible({ timeout: WAIT });
    await toggleToLight(page);

    await page.goto("/?kitchen-sink");
    const sink = page.getByTestId("kitchen-sink");
    await expect(sink).toBeVisible({ timeout: WAIT });
    await expect(page.getByRole("heading", { name: "Kitchen sink" })).toBeVisible();
    if (PIXELS) await expect(page).toHaveScreenshot("kitchen-sink-light.png");

    // Put the shell back to dark for later tests/specs in the same run.
    await page.goto("/");
    await expect(page.getByTestId("theme-toggle")).toHaveAttribute("data-mode", "light", { timeout: WAIT });
    await page.getByTestId("theme-toggle").click();
  });

  test("listing matches the baseline", async ({ page }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    await expect(page.locator("[data-module]").first()).toBeVisible();
    await expect(page.getByRole("tree", { name: "module tree" })).toBeVisible();
    if (PIXELS) await expect(page).toHaveScreenshot("listing.png");
  });

  test("right pane: xrefs matches the baseline", async ({ page }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    await page.getByRole("tab", { name: "Xrefs" }).click();
    await expect(page.getByRole("tabpanel", { name: "Xrefs" })).toBeVisible({ timeout: WAIT });
    if (PIXELS) await expect(page).toHaveScreenshot("xrefs.png");
  });

  test("graph pane matches the baseline", async ({ page }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    await page.getByRole("tab", { name: "Graph" }).click();
    const graphPane = page.locator("[data-graph-pane]");
    await expect(graphPane).toBeVisible({ timeout: WAIT });
    // Let react-flow's fitView (a requestAnimationFrame call, GraphPane.tsx)
    // settle before either assertion — a screenshot mid-fit is exactly the
    // kind of animation-timing flake this layer must not have.
    await page.waitForTimeout(300);
    if (PIXELS) await expect(page).toHaveScreenshot("graph.png");
  });
});
