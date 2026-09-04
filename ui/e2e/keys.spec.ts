// ui/e2e/keys.spec.ts — review-2026-09-05-keys (docs/BUGS.md): the owner
// reported "there is no theme conf; none of the key bindings work". This
// spec presses the DEFAULT chords and asserts the visible effect, opens the
// cheat-sheet, and drives the Settings dialog (theme, density, and the
// key-binding editor) including persistence across a reload.
//
// It runs read-only: every chord it fires opens a dialog or switches a
// panel, and each dialog is dismissed with Escape — nothing is submitted, so
// `npm run e2e:nsw` against Fred's live rig cannot mutate the corpus.
import { test, expect, type Page } from "@playwright/test";

const MOD = process.platform === "darwin" ? "Meta" : "Control";
const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 10_000;
const SHORT = process.env["PW_BASE_URL"] !== undefined ? 20_000 : 5_000;

async function openFirstFn(page: Page): Promise<void> {
  const firstModule = page.locator("[data-module]").first();
  await expect(firstModule).toBeVisible({ timeout: WAIT });
  const firstFn = page.locator("[data-fn]").first();
  if (!(await firstFn.isVisible().catch(() => false))) await firstModule.click();
  await expect(firstFn).toBeVisible({ timeout: WAIT });
  await firstFn.click();
}

/** Clears whatever a chord opened so the next chord starts from a clean
 *  shell (the palette, the cheat-sheet and every dialog all close on Escape). */
async function dismiss(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
}

test.describe("keymap", () => {
  test("every default chord fires, including with focus in the code pane", async ({ page }) => {
    await page.goto("/");
    await openFirstFn(page);

    // The palette: the chord the top bar has always advertised (Cmd/Ctrl-K)
    // plus the one the preset names (Ctrl-P). Both were dead before the fix.
    for (const chord of ["k", "p"]) {
      await page.keyboard.press(`${MOD}+${chord}`);
      await expect(page.getByPlaceholder("Run a command")).toBeVisible({ timeout: SHORT });
      await dismiss(page);
    }

    // Focus inside CodeMirror — the chords must still fire there.
    const codeView = page.getByTestId("code-view").first();
    await expect(codeView).toBeVisible({ timeout: WAIT });
    await codeView.click();
    await page.keyboard.press("?");
    await expect(page.getByTestId("keymap-help")).toBeVisible({ timeout: SHORT });
    await dismiss(page);

    await page.keyboard.press(`${MOD}+,`);
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible({ timeout: SHORT });
    await dismiss(page);

    // Search: Ctrl-F focuses the function search box.
    await page.keyboard.press(`${MOD}+f`);
    await expect(page.locator('input[aria-label="search functions"]')).toBeFocused({ timeout: SHORT });
    await page.locator('input[aria-label="search functions"]').blur();

    // Annotate chords open their dialogs on the selected function.
    await page.keyboard.press("F2");
    await expect(page.getByRole("dialog", { name: /Rename/i })).toBeVisible({ timeout: SHORT });
    await dismiss(page);

    await page.keyboard.press(`${MOD}+/`);
    await expect(page.getByRole("dialog", { name: /comment/i })).toBeVisible({ timeout: SHORT });
    await dismiss(page);

    // Navigate chords switch the right-hand panel.
    await page.keyboard.press(`${MOD}+Shift+S`);
    await expect(page.getByTestId("search-strings")).toBeVisible({ timeout: WAIT });
  });

  test("the cheat-sheet lists the live keymap", async ({ page }) => {
    await page.goto("/");
    await openFirstFn(page);
    await page.keyboard.press("?");
    const help = page.getByTestId("keymap-help");
    await expect(help).toBeVisible({ timeout: SHORT });
    // Every registry action has a row; the palette's row shows a chord.
    await expect(help.locator("[data-shortcut]")).not.toHaveCount(0);
    await expect(help.locator('[data-shortcut="project.palette"] [data-shortcut-chord]')).not.toHaveText("—");
  });
});

test.describe("command mode (bur 4/5)", () => {
  test("bare '/' outside an input focuses the search box", async ({ page }) => {
    await page.goto("/");
    await openFirstFn(page);
    const codeView = page.getByTestId("code-view").first();
    await expect(codeView).toBeVisible({ timeout: WAIT });
    await codeView.click();
    await page.keyboard.press("/");
    await expect(page.locator('input[aria-label="search functions"]')).toBeFocused({ timeout: SHORT });
    await page.locator('input[aria-label="search functions"]').blur();
  });

  test("':' opens the palette prefilled with ':', and ':fn 74' navigates to fn 74", async ({ page }) => {
    await page.goto("/");
    await openFirstFn(page);

    await page.keyboard.press(":");
    const input = page.getByPlaceholder(/Type a command/);
    await expect(input).toBeVisible({ timeout: SHORT });
    await expect(input).toHaveValue(":");

    // One `.fill()` (never an intermediate empty value): the placeholder
    // itself depends on whether the query starts with ":", so clearing it
    // first would make `getByPlaceholder(/Type a command/)` go stale mid-test.
    await input.fill(":fn 74");
    await expect(input).toHaveValue(":fn 74");
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("breadcrumbs")).toContainText("fn 74", { timeout: WAIT });
  });
});

test.describe("settings", () => {
  test("theme mode toggle switches live and survives a reload (bur 6)", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press(`${MOD}+,`);
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible({ timeout: SHORT });

    const bg = async (): Promise<string> =>
      page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
    const before = await bg();
    // bur 6: light/dark is a switch, not a dropdown entry — the family
    // dropdown (bur 3) is left on its default ("default": ui/themes/dark.json
    // + light.json) and only the mode toggle flips.
    const modeToggle = dialog.locator('[data-testid="theme-mode-toggle"]');
    await expect(modeToggle).toHaveAttribute("data-mode", "dark");
    await modeToggle.click();
    await expect(modeToggle).toHaveAttribute("data-mode", "light");
    await expect.poll(bg, { timeout: SHORT }).not.toBe(before);
    const after = await bg();

    await page.reload();
    await expect.poll(bg, { timeout: WAIT }).toBe(after);

    // Put it back so the next test starts from the shipped preset.
    await page.keyboard.press(`${MOD}+,`);
    await page.getByRole("dialog", { name: "Settings" }).locator('[data-testid="theme-mode-toggle"]').click();
    await expect.poll(bg, { timeout: SHORT }).toBe(before);
  });

  test("rebinding an action: new chord works, old one does not, survives reload, resets", async ({ page }) => {
    await page.goto("/");
    await openFirstFn(page);

    const openSettingsKeys = async (): Promise<void> => {
      await page.keyboard.press(`${MOD}+,`);
      await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible({ timeout: SHORT });
      await page.locator('[data-tab="keys"]').click();
    };

    await openSettingsKeys();
    const row = page.locator('[data-binding-row="project.palette"]');
    await expect(row).toBeVisible({ timeout: SHORT });
    await row.locator('[data-record="project.palette"]').click();
    await page.keyboard.press(`${MOD}+j`);
    await expect(row.locator("[data-binding-chord]")).toContainText("J", { timeout: SHORT });
    await dismiss(page);

    // The new chord opens the palette; the preset chord no longer does.
    await page.keyboard.press(`${MOD}+j`);
    await expect(page.getByPlaceholder("Run a command")).toBeVisible({ timeout: SHORT });
    await dismiss(page);
    await page.keyboard.press(`${MOD}+p`);
    await expect(page.getByPlaceholder("Run a command")).toHaveCount(0);

    // Persisted like the theme is.
    await page.reload();
    await expect(page.locator("[data-module]").first()).toBeVisible({ timeout: WAIT });
    await page.keyboard.press(`${MOD}+j`);
    await expect(page.getByPlaceholder("Run a command")).toBeVisible({ timeout: SHORT });
    await dismiss(page);

    // Per-row reset puts the preset chord back.
    await openSettingsKeys();
    await page.locator('[data-reset="project.palette"]').click();
    await dismiss(page);
    await page.keyboard.press(`${MOD}+p`);
    await expect(page.getByPlaceholder("Run a command")).toBeVisible({ timeout: SHORT });
    await dismiss(page);

    await openSettingsKeys();
    await page.getByTestId("reset-all-bindings").click();
    await dismiss(page);
  });

  test("a conflicting chord is reported inline and can be cancelled", async ({ page }) => {
    await page.goto("/");
    await openFirstFn(page);
    await page.keyboard.press(`${MOD}+,`);
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible({ timeout: SHORT });
    await page.locator('[data-tab="keys"]').click();

    const row = page.locator('[data-binding-row="project.shortcuts"]');
    await row.locator('[data-record="project.shortcuts"]').click();
    await page.keyboard.press(`${MOD}+f`); // already bound to project.search
    const conflict = page.getByTestId("binding-conflict");
    await expect(conflict).toBeVisible({ timeout: SHORT });
    await expect(conflict).toContainText("Search project");
    await page.getByTestId("conflict-cancel").click();
    await expect(conflict).toHaveCount(0);
    // Nothing changed: the cheat-sheet chord is still "?".
    await expect(row.locator("[data-binding-chord]")).toHaveText("?");
    await dismiss(page);
  });
});
