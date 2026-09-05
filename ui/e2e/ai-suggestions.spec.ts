// ui/e2e/ai-suggestions.spec.ts — outcome coverage for the AI tab (spec 23
// §6, ui/src/panes/WorkersPane.tsx): "Suggest name" queues a job against
// the local, network-free `HeuristicBackend` (src/ui-server/server.ts's
// `startWorkers`), the job reaches `done`, a suggestion row appears, and
// Accept (promote) actually renders the new name in the code pane — not
// merely that a dialog/row appeared (docs/AGENT-LOG.md 2026-09-05,
// e2e-gate task: Fred found the rename dialog opens but "doesn't actually
// rename anything"; this file is the AI-flow half of that same class of
// escape, the palette-driven manual rename is code-pane-rename.spec.ts).
import { test, expect, type Locator, type Page } from "@playwright/test";

const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 15_000;
const READONLY = process.env["PW_READONLY"] === "1";

async function openFirstModuleAndFn(page: Page): Promise<Locator> {
  const firstModule = page.locator("[data-module]").first();
  await expect(firstModule).toBeVisible({ timeout: WAIT });
  const firstFn = page.locator("[data-fn]").first();
  if (!(await firstFn.isVisible().catch(() => false))) await firstModule.click();
  await expect(firstFn).toBeVisible({ timeout: WAIT });
  return firstFn;
}

const codeView = (page: Page): Locator => page.getByTestId("code-view").first();

test.describe("AI tab: suggest name reaches a real outcome (spec 23 SS6)", () => {
  test("Suggest name enqueues a job that reaches done and a suggestion row appears", async ({ page }) => {
    test.skip(READONLY, "queues a write job — skipped on the read-only NSW run");
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    await expect(codeView(page).locator(".cm-content")).not.toBeEmpty({ timeout: WAIT });

    await page.getByRole("tab", { name: "AI" }).click();
    const suggestButton = page.getByRole("button", { name: "Suggest name" });
    await expect(suggestButton).toBeVisible({ timeout: WAIT });
    await suggestButton.click();

    // The job must actually finish (HeuristicBackend, local + synchronous
    // fast enough to poll for) — not merely "queued", which is a surface
    // check that says nothing about whether the worker pool runs at all.
    await expect(page.getByText(/^done /).or(page.getByText("done", { exact: true }))).toBeVisible({ timeout: WAIT });

    const suggestionRow = page.locator("text=/^name$/").first();
    await expect(suggestionRow).toBeVisible({ timeout: WAIT });
    await expect(page.getByRole("button", { name: "Accept" }).first()).toBeVisible({ timeout: WAIT });
  });

  test("Accept renders the suggested name in the code pane", async ({ page }) => {
    test.skip(READONLY, "promote is a write — skipped on the read-only NSW run");
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    await expect(codeView(page).locator(".cm-content")).not.toBeEmpty({ timeout: WAIT });

    await page.getByRole("tab", { name: "AI" }).click();
    await page.getByRole("button", { name: "Suggest name" }).click();
    await expect(page.getByRole("button", { name: "Accept" }).first()).toBeVisible({ timeout: WAIT });

    // The row's own monospace text is the exact string the accept must
    // land: read it back rather than hard-coding a name, since the
    // heuristic's guess is derived from the fixture function's own shape.
    const suggested = (await page.locator(".font-mono").filter({ hasText: /./ }).first().textContent())?.trim();
    expect(suggested, "the suggestion row should show a proposed name").toBeTruthy();

    await page.getByRole("button", { name: "Accept" }).first().click();

    // FIXME (docs/BUGS.md "AI suggest-name Accept does not update the open
    // code pane"): promote() invalidates the fn query, but nothing here
    // re-renders CodeView with the new name unless a fresh read genuinely
    // carries it end to end — this is the actual outcome, not the toast.
    await expect(codeView(page).locator(".cm-content")).toContainText(suggested!, { timeout: WAIT });
  });
});
