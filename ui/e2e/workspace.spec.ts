// ui/e2e/workspace.spec.ts — spec 26 L10 acceptance tests: selection/panel
// <-> URL round-trip (i), two docked right panels (ii), and "reset layout"
// (iii). Same fixture rig as every other e2e spec (ui/e2e/prepare-fixture.mjs).
import { test, expect, type ConsoleMessage, type Locator, type Page } from "@playwright/test";

const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 15_000;

function collectErrors(page: Page): { errors: string[] } {
  const state = { errors: [] as string[] };
  page.on("pageerror", (err) => state.errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") state.errors.push(`console.error: ${msg.text()}`);
  });
  return state;
}

/** The first module is already open on load; open it only if needed, then
 *  return its first function row (same helper as smoke.spec.ts /
 *  listing-nav.spec.ts). */
async function openFirstModuleAndFn(page: Page): Promise<Locator> {
  const firstModule = page.locator("[data-module]").first();
  await expect(firstModule).toBeVisible({ timeout: WAIT });
  const firstFn = page.locator("[data-fn]").first();
  if (!(await firstFn.isVisible().catch(() => false))) await firstModule.click();
  await expect(firstFn).toBeVisible({ timeout: WAIT });
  return firstFn;
}

/** The numeric fn id of the FIRST function row in the tree — a real fn the
 *  fixture project can answer `/api/fn/{fn}/context` for. */
async function firstFnId(page: Page): Promise<number> {
  await page.goto("/");
  const firstFn = await openFirstModuleAndFn(page);
  const raw = await firstFn.getAttribute("data-fn");
  expect(raw).not.toBeNull();
  return Number(raw);
}

test.describe("hbc2js workspace: URL addressing + docking (spec 26 L10)", () => {
  test("a deep link opens the named function", async ({ page }) => {
    const fn = await firstFnId(page);
    await page.goto(`/?fn=${fn}`);
    await expect(page.getByTestId("right-panel-fn-primary")).toHaveText(String(fn), { timeout: WAIT });
  });

  test("reload restores the selection", async ({ page }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    const fn = Number(await firstFn.getAttribute("data-fn"));
    await firstFn.click();
    await expect(page.getByTestId("right-panel-fn-primary")).toHaveText(String(fn), { timeout: WAIT });
    // The click above pushed `?fn=…` onto the URL (spec 26 L10 (i)) — a
    // plain reload must land on the SAME selection, not the blank default.
    await page.reload();
    await expect(page.getByTestId("right-panel-fn-primary")).toHaveText(String(fn), { timeout: WAIT });
  });

  test("two right panels can be shown at once", async ({ page }) => {
    const fn = await firstFnId(page);
    await page.goto(`/?fn=${fn}`);
    await expect(page.getByTestId("right-panel-primary")).toBeVisible({ timeout: WAIT });
    await expect(page.getByTestId("right-panel-secondary")).toHaveCount(0);

    await page.getByTestId("right-panel-split").click();
    const secondary = page.getByTestId("right-panel-secondary");
    await expect(secondary).toBeVisible({ timeout: WAIT });
    // Both slots show live content for the same fn, independently.
    await expect(page.getByTestId("right-panel-fn-primary")).toHaveText(String(fn));

    await page.getByTestId("right-panel-close").click();
    await expect(secondary).toHaveCount(0);
  });

  test("reset layout restores the default", async ({ page }) => {
    await page.goto("/");
    // Move off the default tab AND open a split, so "reset" restoring both
    // is not trivially true of the untouched initial state.
    await page.getByTestId("right-panel-primary").getByRole("tab", { name: "Xrefs" }).click();
    await page.getByTestId("right-panel-split").click();
    await expect(page.getByTestId("right-panel-secondary")).toBeVisible({ timeout: WAIT });

    await page.getByTestId("layout-reset").click();
    await expect(page.getByTestId("right-panel-secondary")).toHaveCount(0);
    // Reset also puts the primary panel back on its default tab (Context).
    const contextTab = page.getByTestId("right-panel-primary").getByRole("tab", { name: "Context" });
    await expect(contextTab).toHaveAttribute("data-state", "active");
  });

  test("no console errors on first paint", async ({ page }) => {
    const fn = await firstFnId(page);
    const state = collectErrors(page);
    // A deep link (with a panel + split-adjacent state) is the scenario
    // ui/e2e/smoke.spec.ts's plain "/" load does not cover. `panel=xrefs`
    // means the Context tab (and its `right-panel-fn-*` testid) is not
    // even mounted (Radix Tabs unmounts inactive content) — wait on the
    // Xrefs tab's own content instead.
    await page.goto(`/?fn=${fn}&panel=xrefs`);
    const xrefsTab = page.getByTestId("right-panel-primary").getByRole("tab", { name: "Xrefs" });
    await expect(xrefsTab).toHaveAttribute("data-state", "active", { timeout: WAIT });
    await expect(page.getByText(/called by \(/)).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(1000);
    expect(state.errors, state.errors.join("\n")).toEqual([]);
  });
});
