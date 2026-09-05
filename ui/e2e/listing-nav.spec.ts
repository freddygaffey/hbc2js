// ui/e2e/listing-nav.spec.ts — bur 13 (docs/UI-BURS.md #13): "arrow keys
// should move the selection down (and up) the reader". ArrowDown/ArrowUp
// step the listing's selected line, driven through the shared action
// registry (listing.lineDown/listing.lineUp, src/ui-core/actions.ts) exactly
// like a click does — same `data-selected-line` contract ui/e2e/code-
// pane.spec.ts already asserts for the mouse path.
import { test, expect, type Locator, type Page } from "@playwright/test";

const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 15_000;

async function openFirstModuleAndFn(page: Page): Promise<Locator> {
  const firstModule = page.locator("[data-module]").first();
  await expect(firstModule).toBeVisible({ timeout: WAIT });
  const firstFn = page.locator("[data-fn]").first();
  if (!(await firstFn.isVisible().catch(() => false))) await firstModule.click();
  await expect(firstFn).toBeVisible({ timeout: WAIT });
  return firstFn;
}

const codeView = (page: Page): Locator => page.getByTestId("code-view").first();

/** Viewport coordinates of the `nth` whole-word occurrence of `word`, same
 *  text-node walk ui/e2e/code-pane.spec.ts uses so this file does not care
 *  how CodeMirror splits a line into highlight spans. */
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

function selectedLine(page: Page): Promise<string | null> {
  return codeView(page).getAttribute("data-selected-line");
}

test.describe("listing keyboard navigation (bur 13)", () => {
  test("ArrowDown advances the selected line by one and it is in view; ArrowUp reverses", async ({ page }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    await expect(codeView(page).locator(".cm-content")).not.toBeEmpty({ timeout: WAIT });

    // Seed a starting selection the way a user would: click a token on some
    // line that is not the very first (so ArrowUp has somewhere to go back
    // to and this is not just "nothing happened at line 1").
    const text = (await codeView(page).locator(".cm-content").innerText()) ?? "";
    const word = /(^|[^A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]{3,})\s*\(/m.exec(text)?.[2];
    expect(word, "the listing should contain at least one call site").toBeTruthy();
    const point = await wordPoint(page, word!);
    expect(point, `"${word!}" should be on screen`).not.toBeNull();
    await page.mouse.click(point!.x, point!.y);
    await expect(codeView(page)).toHaveAttribute("data-selected-token", word!, { timeout: WAIT });

    const startLine = Number(await selectedLine(page));
    expect(Number.isFinite(startLine)).toBeTruthy();

    await page.keyboard.press("ArrowDown");
    await expect
      .poll(async () => Number(await selectedLine(page)), { timeout: WAIT })
      .toBe(startLine + 1);

    // "in view": the decorated line is on screen, not scrolled away.
    const decorated = page.locator(".hbc-selected-line").first();
    await expect(decorated).toBeVisible({ timeout: WAIT });
    await expect(decorated).toBeInViewport();

    await page.keyboard.press("ArrowUp");
    await expect
      .poll(async () => Number(await selectedLine(page)), { timeout: WAIT })
      .toBe(startLine);
  });
});
