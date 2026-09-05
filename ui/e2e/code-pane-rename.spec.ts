// ui/e2e/code-pane-rename.spec.ts — bur 15 (docs/UI-BURS.md #15): "replace
// triple click with jump to and a double click with rename" in the main
// editing panel (Fred, relayed to the graph-node bur 14 agent). Single
// click still selects the token (bur 2, ../e2e/code-pane.spec.ts); the
// TARGET of the old bur-7 double-click ("go to what it names") moved to a
// TRIPLE click, and a plain double-click now opens the rename dialog for
// the token instead — reusing the SAME dialog the context menu's Rename
// opens (../src/actions/registry.ts's `setName` -> `openDialog("rename",
// …)`), never navigating.
//
// A triple click fires the DOM's `dblclick` on its way to `click`(detail
// 3) (mousedown/up, click(1), mousedown/up, click(2), dblclick,
// mousedown/up, click(3) — never a second `dblclick`), so
// ../src/listing/CodeView.tsx defers the rename and cancels it when the
// third click lands; this file's second test is the guard against that
// race regressing.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { API_PORT } from "./prepare-fixture.mjs";

const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 15_000;
const API = process.env["PW_API_BASE"] ?? `http://127.0.0.1:${API_PORT}`;

async function openFirstModuleAndFn(page: Page): Promise<Locator> {
  const firstModule = page.locator("[data-module]").first();
  await expect(firstModule).toBeVisible({ timeout: WAIT });
  const firstFn = page.locator("[data-fn]").first();
  if (!(await firstFn.isVisible().catch(() => false))) await firstModule.click();
  await expect(firstFn).toBeVisible({ timeout: WAIT });
  return firstFn;
}

const codeView = (page: Page): Locator => page.getByTestId("code-view").first();

async function listingText(page: Page): Promise<string> {
  return (await codeView(page).locator(".cm-content").innerText()) ?? "";
}

/** Same as ../e2e/code-pane.spec.ts's: the fn the pane currently has
 *  selected, as the disasm bar reports it. */
async function selectedFn(page: Page): Promise<string | null> {
  const text = (await page.getByTestId("disasm-fold").locator("span").nth(1).textContent()) ?? "";
  return /fn (\d+)/.exec(text)?.[1] ?? null;
}

/** Viewport coordinates of the `nth` whole-word occurrence of `word` — same
 *  text-node walk ../e2e/code-pane.spec.ts and ../e2e/listing-nav.spec.ts
 *  use, so this file does not care how CodeMirror splits a line into
 *  highlight spans. */
async function wordPoint(page: Page, word: string, nth = 0): Promise<{ x: number; y: number } | null> {
  return page.evaluate(
    ({ word, nth }: { word: string; nth: number }) => {
      const content = document.querySelector('[data-testid="code-view"] .cm-content');
      if (content === null) return null;
      const isWord = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        const text = n.nodeValue ?? "";
        let at = text.indexOf(word);
        while (at !== -1) {
          const before = at === 0 ? undefined : text[at - 1];
          const after = text[at + word.length];
          if (!isWord(before) && !isWord(after)) {
            const range = document.createRange();
            range.setStart(n, at);
            range.setEnd(n, at + word.length);
            const r = range.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              if (seen === nth) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
              seen += 1;
            }
          }
          at = text.indexOf(word, at + word.length);
        }
      }
      return null;
    },
    { word, nth },
  );
}

test.describe("code pane: double = rename, triple = jump (bur 15)", () => {
  test("double-click an identifier opens the rename dialog and does not navigate", async ({ page }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    await expect(codeView(page).locator(".cm-content")).not.toBeEmpty({ timeout: WAIT });
    const before = await selectedFn(page);
    expect(before, "a function should be selected before the double-click").not.toBeNull();

    const text = await listingText(page);
    const word = /(^|[^A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]{3,})\s*\(/m.exec(text)?.[2];
    expect(word, "the listing should contain at least one call site to double-click").toBeTruthy();
    const point = await wordPoint(page, word!);
    expect(point, `"${word!}" should be on screen`).not.toBeNull();

    await page.mouse.dblclick(point!.x, point!.y);

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: WAIT });
    await expect(page.locator("#hbc-rename-input")).toBeVisible();
    // Double-click never navigates — still the same function.
    expect(await selectedFn(page)).toBe(before);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden({ timeout: WAIT });
  });

  test("triple-click (clickCount: 3) navigates to the definition and opens no dialog", async ({ page }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    await expect(codeView(page).locator(".cm-content")).not.toBeEmpty({ timeout: WAIT });
    const before = await selectedFn(page);

    // The emitter's own nested-closure name (`_fn<n>`, src/emit/index.ts
    // §6) always resolves, exactly like ../e2e/code-pane.spec.ts's bur-7
    // test — the fixture is not guaranteed to have one on screen, so fall
    // back to a named call site resolved through the search API.
    const text = await listingText(page);
    const emitted = /(^|[^A-Za-z0-9_$])(_fn([0-9]+))(?![A-Za-z0-9_$])/m.exec(text);
    let point: { x: number; y: number } | null = null;
    let expectFn: string | null = null;
    if (emitted !== null && (await wordPoint(page, emitted[2]!)) !== null) {
      point = await wordPoint(page, emitted[2]!);
      expectFn = emitted[3]!;
    } else {
      const candidates: string[] = [];
      for (const m of text.matchAll(/(^|[^A-Za-z0-9_$.])([A-Za-z_$][A-Za-z0-9_$]{2,})\s*\(/gm)) {
        const name = m[2]!;
        if (!candidates.includes(name)) candidates.push(name);
        if (candidates.length >= 40) break;
      }
      for (const name of candidates) {
        const res = await fetch(`${API}/api/search/functions?q=${encodeURIComponent(name)}`);
        if (!res.ok) continue;
        const page1 = (await res.json()) as { rows: { fn: number; name: string | null }[] };
        const exact = page1.rows.filter((r) => r.name === name);
        const p = exact.length > 0 ? await wordPoint(page, name) : null;
        if (exact.length > 0 && String(exact[0]!.fn) !== before && p !== null) {
          point = p;
          expectFn = String(exact[0]!.fn);
          break;
        }
      }
    }
    expect(point, "the fixture should contain a resolvable navigation target").not.toBeNull();

    await page.mouse.click(point!.x, point!.y, { clickCount: 3 });

    await expect.poll(async () => selectedFn(page), { timeout: WAIT }).toBe(expectFn);
    // No rename dialog ever appeared, even transiently — the debounced
    // rename must have been cancelled by the third click, not merely
    // outrun by it.
    await expect(page.getByRole("dialog")).toBeHidden();
  });
  // The bug this test exists for (Fred, 2026-09-05): "The rename opens up a
  // pop up very nicely on a double click, but then it doesn't actually
  // rename anything." The two tests above only checked that the dialog
  // OPENS — which is exactly how a write that changed nothing on screen got
  // through. This one submits and asserts the OUTCOME, in the code pane, the
  // function list and the top bar, and after a reload.
  test("submitting the rename dialog renames the function everywhere and survives a reload", async ({ page }) => {
    test.skip(process.env["PW_READONLY"] === "1", "read-only rig: never writes to Fred's live project");
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    await expect(codeView(page).locator(".cm-content")).not.toBeEmpty({ timeout: WAIT });
    const fn = await selectedFn(page);
    expect(fn, "a function should be selected").not.toBeNull();

    // The function's OWN header ident (`function <ident>(` on the first line
    // of its rendered source): not a nameable local, so the dialog falls
    // back to renaming the enclosing function — target `fn:N`, the case that
    // was broken. Reading it off the pane keeps the test independent of how
    // the emitter chose to name this fixture's functions.
    const text = await listingText(page);
    const header = /function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(text);
    expect(header, "the pane should show a function header").not.toBeNull();
    const point = await wordPoint(page, header![1]!);
    expect(point, `"${header![1]!}" should be on screen`).not.toBeNull();

    await page.mouse.dblclick(point!.x, point!.y);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: WAIT });
    // The dialog states its own target; this test is about the `fn:N` one.
    await expect(dialog).toContainText(`fn:${fn!}`, { timeout: WAIT });

    const newName = `renamedByE2e${Date.now().toString(36)}`;
    const input = page.locator("#hbc-rename-input");
    await input.fill(newName);
    await dialog.getByRole("button", { name: "Rename" }).click();
    await expect(dialog).toBeHidden({ timeout: WAIT });

    // (1) the code pane re-renders with the new declaration
    await expect
      .poll(async () => listingText(page), { timeout: WAIT })
      .toContain(`function ${newName}(`);
    // (2) the top bar breadcrumb and (3) the function list row
    await expect(page.getByTestId("breadcrumbs")).toContainText(newName, { timeout: WAIT });
    await expect(page.locator(`[data-fn="${fn!}"]`).first()).toContainText(newName, { timeout: WAIT });

    // (4) it is server state, not client state: reload and look again
    await page.reload();
    await expect(page.locator(`[data-fn="${fn!}"]`).first()).toContainText(newName, { timeout: WAIT });
    await page.locator(`[data-fn="${fn!}"]`).first().click();
    await expect
      .poll(async () => listingText(page), { timeout: WAIT })
      .toContain(`function ${newName}(`);
  });
});
