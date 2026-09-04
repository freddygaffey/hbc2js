// ui/e2e/smoke.spec.ts — the Playwright smoke suite (docs/UI.md "Smoke test
// (Playwright)"). `npm run e2e` runs it against a throwaway project on our
// own ui-server (:7341) + vite preview (:7342); `npm run e2e:nsw` runs the
// read-only steps against Fred's live NSW rig (:4173 / :7331) without
// restarting or modifying it (PW_READONLY=1 skips the rename step, which
// writes).
import { test, expect, type ConsoleMessage, type Locator, type Page } from "@playwright/test";

const READONLY = process.env["PW_READONLY"] === "1";

// The live NSW rig (4,510 modules) can take up to ~70s to answer
// /api/segregation on a loaded box (docs/UI.md); the fixture project
// (435 modules) never needs more than a couple of seconds. Long, not
// short, when in doubt about a shared dev machine under load.
const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 10_000;
const SHORT_WAIT = process.env["PW_BASE_URL"] !== undefined ? 20_000 : 5_000;

/** Attaches pageerror/console-error collectors and fails the test at the
 *  end with the full list, per the brief ("collect them all; fail at the
 *  end with the list") rather than on the first hit, so one run reports
 *  everything broken instead of just the first symptom. */
function collectErrors(page: Page): { errors: string[] } {
  const state = { errors: [] as string[] };
  page.on("pageerror", (err) => state.errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") state.errors.push(`console.error: ${msg.text()}`);
  });
  return state;
}

/** The first module is already open (LeftPane auto-selects and expands it
 *  on first load, once segregation has settled) — so a blind click would
 *  TOGGLE it closed rather than open it. Click only if its function rows
 *  are not already visible, then return the first function row. */
async function openFirstModuleAndFn(page: Page): Promise<Locator> {
  const firstModule = page.locator("[data-module]").first();
  await expect(firstModule).toBeVisible({ timeout: WAIT });
  const firstFn = page.locator("[data-fn]").first();
  if (!(await firstFn.isVisible().catch(() => false))) {
    await firstModule.click();
  }
  await expect(firstFn).toBeVisible({ timeout: WAIT });
  return firstFn;
}

test.describe("hbc2js UI shell smoke", () => {
  test("loads with no console/page errors", async ({ page }) => {
    const state = collectErrors(page);
    await page.goto("/");
    await expect(page.getByRole("tree", { name: "module tree" })).toBeVisible();
    // Give async data (segregation, modules) a moment to settle before
    // judging the console clean.
    await page.waitForTimeout(1000);
    // FIXED: App.tsx used to default the selected `fn` to 0
    // (`useSelection().fn ?? 0`) before anything was selected, so
    // RightPane queried `/api/fn/0/context` etc. on first paint — fn 0 (the
    // global function) has no recorded source range and answered 400,
    // which the browser logs as a console error regardless of app code.
    // App.tsx now defaults to `-1`, a sentinel RightPane/CenterPane already
    // treat as "no selection" (`perFn()` in hooks.ts), so no request is
    // made until something is actually selected. No allowlist needed —
    // any console error fails this test.
    expect(state.errors, state.errors.join("\n")).toEqual([]);
  });

  test("tree renders groups, expands a group, module click shows file, fn click updates context", async ({ page }) => {
    await page.goto("/");
    const tree = page.getByRole("tree", { name: "module tree" });
    await expect(tree).toBeVisible();

    const firstGroup = page.locator("[data-group]").first();
    await expect(firstGroup).toBeVisible({ timeout: WAIT });
    // The first group opens itself on load (LeftPane's default-open effect);
    // if it is somehow collapsed, open it explicitly.
    if ((await firstGroup.locator("span").first().textContent()) === ">") {
      await firstGroup.click();
    }

    const codeView = page.getByTestId("code-view");
    await expect(codeView).toBeVisible();
    await expect(codeView.locator(".cm-content")).not.toBeEmpty({ timeout: WAIT });

    // Open the module (functions are only fetched/shown for open modules)
    // and click the first function row in its file's function list.
    const firstFn = await openFirstModuleAndFn(page);
    const fnId = await firstFn.getAttribute("data-fn");
    expect(fnId).not.toBeNull();
    await firstFn.click();

    // Right pane Context tab shows the "fn" row with the clicked fn's id —
    // KeyVal renders `<span class="w-28">fn</span><span>{value}</span>`.
    const fnLabel = page.locator("span.w-28", { hasText: /^fn$/ });
    await expect(fnLabel).toBeVisible({ timeout: WAIT });
    const fnValue = fnLabel.locator("xpath=following-sibling::span[1]");
    await expect(fnValue).toHaveText(String(fnId), { timeout: WAIT });
  });

  test("right-click on code opens the context menu, Escape closes it, Rename… opens and cancels", async ({ page }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();

    const codeLine = page.locator(".cm-content .cm-line").first();
    await expect(codeLine).toBeVisible({ timeout: WAIT });
    await codeLine.click({ button: "right" });

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: SHORT_WAIT });

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden({ timeout: SHORT_WAIT });

    await codeLine.click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible({ timeout: SHORT_WAIT });
    const renameItem = page.getByRole("menuitem", { name: /^Rename/ });
    await expect(renameItem).toBeVisible();
    await renameItem.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: SHORT_WAIT });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden({ timeout: SHORT_WAIT });
  });

  test("back/forward restore prior selections", async ({ page }) => {
    await page.goto("/");
    const modules = page.locator("[data-module]");
    await expect(modules.first()).toBeVisible({ timeout: WAIT });
    // Open every group so a fixture with one module per open group (e.g. a
    // one-module "App" group plus a collapsed "Unclassified") still exposes
    // two modules to pick from, instead of skipping.
    if ((await modules.count()) < 2) {
      const groups = page.locator("[data-group]");
      const groupCount = await groups.count();
      for (let i = 0; i < groupCount; i += 1) {
        const row = groups.nth(i);
        const marker = await row.locator("span").first().textContent();
        if (marker === ">") await row.click();
      }
    }
    const count = await modules.count();
    test.skip(count < 2, "fixture/rig needs at least two modules to exercise back/forward");

    const back = page.getByRole("button", { name: "back" });
    const forward = page.getByRole("button", { name: "forward" });

    await modules.nth(0).click();
    await page.waitForTimeout(200);
    await modules.nth(1).click();
    await page.waitForTimeout(200);

    await expect(back).toBeEnabled({ timeout: SHORT_WAIT });
    // A module selection shows in the centre pane's editor aria-label
    // ("source of module N") — the right pane's "module" KeyVal only
    // reflects the SELECTED FUNCTION's metadata, which module-kind
    // selections never set.
    const currentModuleId = async (): Promise<string | null> => {
      const label = await page.locator(".cm-content").getAttribute("aria-label");
      return label?.match(/source of module (\d+)/)?.[1] ?? null;
    };
    const secondModuleId = await currentModuleId();

    await back.click();
    await page.waitForTimeout(200);
    const firstModuleId = await currentModuleId();
    expect(firstModuleId).not.toEqual(secondModuleId);

    await expect(forward).toBeEnabled({ timeout: SHORT_WAIT });
    await forward.click();
    await page.waitForTimeout(200);
    const restoredId = await currentModuleId();
    expect(restoredId).toEqual(secondModuleId);
  });

  test("search box: type a function name fragment, get results, click one", async ({ page }) => {
    await page.goto("/");
    const search = page.getByTestId("search-functions");
    await expect(search).toBeVisible({ timeout: WAIT });
    // A single common letter is robust across both the fixture bundle and
    // the live rig's real app code — some function has an "e" in its name.
    await search.fill("e");
    const hit = page.locator("[data-fn]").first();
    await expect(hit).toBeVisible({ timeout: WAIT });
    await hit.click();
    await expect(search).toHaveValue("e");
  });

  test("search: selecting a module in Unclassified opens its group and scrolls it into view", async ({ page }) => {
    await page.goto("/");
    const search = page.getByTestId("search-functions");
    await expect(search).toBeVisible({ timeout: WAIT });
    // "unclassified" matches the GROUP LABEL (filterGroups keeps every
    // module of a group whose own label matches, ui/src/listing/modules.ts)
    // — a query that finds a module deep in the tree's largest, closed-by-
    // default group regardless of what that fixture's modules are named.
    await search.fill("unclassified");
    const hit = page.locator("[data-module]").last();
    await expect(hit).toBeVisible({ timeout: WAIT });
    const moduleId = await hit.getAttribute("data-module");
    expect(moduleId).not.toBeNull();
    await hit.click();
    await search.fill("");
    await expect(search).toHaveValue("");

    // The tree is virtualised (ui/src/panes/LeftPane.tsx): a row only
    // exists in the DOM once the virtualizer has scrolled it into its
    // rendered window, so the row's mere presence here proves the
    // selection-changed scroll-into-view effect actually ran, not just
    // that a row for it exists somewhere off-screen in a fully-rendered
    // tree.
    const treeRow = page.locator(`[data-tree="modules"] [data-module="${moduleId}"]`);
    await expect(treeRow).toBeVisible({ timeout: WAIT });
    const rowBox = await treeRow.boundingBox();
    const containerBox = await page.locator('[data-tree="modules"]').boundingBox();
    expect(rowBox).not.toBeNull();
    expect(containerBox).not.toBeNull();
    // `align: "auto"` (`virtualizer.scrollToIndex`) puts the row flush
    // against whichever edge it was nearest, which can be a few sub-pixels
    // over the container's own fractional height — a slop, not a real
    // scroll failure.
    const SLOP_PX = 6;
    expect(rowBox!.y).toBeGreaterThanOrEqual(containerBox!.y - SLOP_PX);
    expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(containerBox!.y + containerBox!.height + SLOP_PX);
  });

  test("rename via the dialog shows up in Context (acceptedName) and Activity", async ({ page }) => {
    test.skip(READONLY, "rename is a write — skipped on the read-only NSW run");
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();

    const codeLine = page.locator(".cm-content .cm-line").first();
    await expect(codeLine).toBeVisible({ timeout: WAIT });
    await codeLine.click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Rename/ }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: SHORT_WAIT });
    const input = page.locator("#hbc-rename-input");
    await input.fill("zz_smoke");
    await dialog.getByRole("button", { name: "Rename" }).click();
    await expect(dialog).toBeHidden({ timeout: WAIT });

    const nameLabel = page.locator("span.w-28", { hasText: /^name$/ });
    await expect(nameLabel.locator("xpath=following-sibling::span[1]")).toHaveText("zz_smoke", { timeout: WAIT });

    // Activity tab shows at least one row after the submit.
    const activityToggle = page.locator("button", { hasText: "activity" }).first();
    await activityToggle.click();
    const activityRows = page.locator(".hbc-scroll.h-40 > div");
    await expect(activityRows.first()).toBeVisible({ timeout: WAIT });
    expect(await activityRows.count()).toBeGreaterThan(0);
  });

  test("fold gutter present; Cmd-K Fold folds the listing; Show raw Hermes opens the disasm panel", async ({ page }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();

    const codeView = page.getByTestId("code-view").first();
    await expect(codeView).toBeVisible({ timeout: WAIT });
    await expect(codeView.locator(".cm-foldGutter")).toBeVisible({ timeout: WAIT });

    // Cmd-K -> "Fold" -> the listing gets at least one folded placeholder.
    await page.keyboard.press((process.platform === "darwin" ? "Meta" : "Control") + "+k");
    await expect(page.getByPlaceholder("Run a command")).toBeVisible({ timeout: SHORT_WAIT });
    await page.getByPlaceholder("Run a command").fill("Fold");
    await page.getByText("Fold", { exact: true }).click();
    await expect(codeView.locator(".cm-foldPlaceholder").first()).toBeVisible({ timeout: SHORT_WAIT });

    // Collapse the disasm panel via the toggle bar, then re-open it with
    // "Show raw Hermes" from the palette.
    const disasmToggle = page.getByTestId("disasm-fold");
    await expect(disasmToggle).toHaveAttribute("aria-expanded", "true");
    await disasmToggle.click();
    await expect(disasmToggle).toHaveAttribute("aria-expanded", "false");

    await page.keyboard.press((process.platform === "darwin" ? "Meta" : "Control") + "+k");
    await expect(page.getByPlaceholder("Run a command")).toBeVisible({ timeout: SHORT_WAIT });
    await page.getByPlaceholder("Run a command").fill("raw Hermes");
    await page.getByText("Show raw Hermes", { exact: true }).click();
    await expect(disasmToggle).toHaveAttribute("aria-expanded", "true", { timeout: SHORT_WAIT });
  });
});
