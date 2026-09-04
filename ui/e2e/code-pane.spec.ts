// ui/e2e/code-pane.spec.ts — the listing's read-only, token-based selection
// model (docs/UI-BURS.md burs 2 and 7; docs/UI.md "The listing").
//
// Bur 2: the listing must not look editable — no text caret, nothing
// contenteditable — and one click must select a whole TOKEN, not a
// character offset, exposed on the code-view host as `data-selected-token`.
// Bur 7: double-click navigates only when the token actually names
// something; on the keyword `function` it must stay exactly where it is
// (it used to jump to a blank page).
//
// Everything here asserts STATE (attributes, the selected fn as the disasm
// bar reports it), never timing, and the navigable-identifier case is
// DISCOVERED from the fixture through the same API the pane uses rather
// than hard-coded to a function name that may not survive a re-emit.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { API_PORT } from "./prepare-fixture.mjs";

const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 15_000;
const API = process.env["PW_API_BASE"] ?? `http://127.0.0.1:${API_PORT}`;

/** Same as the smoke suite's: the first module is already open, so a blind
 *  click would toggle it closed. */
async function openFirstModuleAndFn(page: Page): Promise<Locator> {
  const firstModule = page.locator("[data-module]").first();
  await expect(firstModule).toBeVisible({ timeout: WAIT });
  const firstFn = page.locator("[data-fn]").first();
  if (!(await firstFn.isVisible().catch(() => false))) await firstModule.click();
  await expect(firstFn).toBeVisible({ timeout: WAIT });
  return firstFn;
}

const codeView = (page: Page): Locator => page.getByTestId("code-view").first();

/** Viewport coordinates of the `nth` whole-word occurrence of `word` in the
 *  rendered listing. Walks the text nodes and measures a Range, so it does
 *  not care how CodeMirror splits a line into highlight spans. `null` when
 *  the word is not on screen. */
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

/** The fn the pane currently has selected, as the disasm bar reports it.
 *  The bar's SECOND span is `disasm · fn N` — `textContent()` on the whole
 *  button would run it into the line count ("fn 74" + "27 lines" reads as
 *  `fn 7427`). */
async function selectedFn(page: Page): Promise<string | null> {
  const text = (await page.getByTestId("disasm-fold").locator("span").nth(1).textContent()) ?? "";
  return /fn (\d+)/.exec(text)?.[1] ?? null;
}

/** The visible listing text, for discovering a token to double-click. */
async function listingText(page: Page): Promise<string> {
  return (await codeView(page).locator(".cm-content").innerText()) ?? "";
}

test.describe("code pane: read-only, token selection, guarded navigation", () => {
  test("the listing has no caret and nothing contenteditable (bur 2)", async ({ page }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    const content = codeView(page).locator(".cm-content");
    await expect(content).toBeVisible({ timeout: WAIT });
    await expect(content).not.toBeEmpty({ timeout: WAIT });

    // CodeMirror marks a non-editable content element `contenteditable=false`
    // (older builds leave the attribute off entirely) — never "true".
    const editable = await content.getAttribute("contenteditable");
    expect(editable === null || editable === "false").toBeTruthy();

    // Focus the pane the way a user would, then look for a caret: with
    // `drawSelection` dropped there is no cursor layer at all.
    await content.click({ position: { x: 4, y: 4 } });
    await expect(content).toBeFocused();
    expect(await page.locator(".cm-cursorLayer").count()).toBe(0);
    expect(await page.locator(".cm-cursor").count()).toBe(0);
  });

  test("one click selects the whole token under the pointer (bur 2)", async ({ page }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    await expect(codeView(page).locator(".cm-content")).not.toBeEmpty({ timeout: WAIT });

    const text = await listingText(page);
    const word = /(^|[^A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]{3,})\s*\(/m.exec(text)?.[2];
    expect(word, "the listing should contain at least one call site").toBeTruthy();
    const point = await wordPoint(page, word!);
    expect(point, `"${word!}" should be on screen`).not.toBeNull();

    // Click in the MIDDLE of the word: the selection is the whole token,
    // not the character under the pointer.
    await page.mouse.click(point!.x, point!.y);
    await expect(codeView(page)).toHaveAttribute("data-selected-token", word!, { timeout: WAIT });
    await expect(codeView(page)).toHaveAttribute("data-selected-token-kind", /identifier|property|definition/);
    // The token is decorated, and so is every other occurrence of it.
    expect(await page.locator(".hbc-token-selected").count()).toBeGreaterThan(0);
  });

  test("double-click on the keyword `function` does not navigate (bur 7)", async ({ page }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    await expect(codeView(page).locator(".cm-content")).not.toBeEmpty({ timeout: WAIT });
    const before = await selectedFn(page);
    expect(before, "a function should be selected before the double-click").not.toBeNull();

    const point = await wordPoint(page, "function");
    expect(point, "the listing should show the keyword `function`").not.toBeNull();
    await page.mouse.dblclick(point!.x, point!.y);

    // The token was resolved — and resolved as a keyword, which has no
    // target, so the selection must not have moved.
    await expect(codeView(page)).toHaveAttribute("data-selected-token", "function", { timeout: WAIT });
    await expect(codeView(page)).toHaveAttribute("data-selected-token-kind", "keyword");
    await expect(page.getByTestId("code-no-target")).toBeVisible({ timeout: 2000 });
    expect(await selectedFn(page)).toBe(before);
  });

  test("double-click on an identifier with a target navigates to it (bur 7)", async ({ page }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    await expect(codeView(page).locator(".cm-content")).not.toBeEmpty({ timeout: WAIT });
    const before = await selectedFn(page);

    // Prefer the emitter's own nested-closure name (`_fn<n>`, src/emit/
    // index.ts §6): it appears in the listing as an ordinary identifier and
    // names function `n` exactly, so the fixture always has a resolvable
    // target. Fall back to a called name the server can resolve by name.
    const text = await listingText(page);
    const emitted = /(^|[^A-Za-z0-9_$])(_fn([0-9]+))(?![A-Za-z0-9_$])/m.exec(text);
    if (emitted !== null && (await wordPoint(page, emitted[2]!)) !== null) {
      const point0 = await wordPoint(page, emitted[2]!);
      await page.mouse.dblclick(point0!.x, point0!.y);
      await expect.poll(async () => selectedFn(page), { timeout: WAIT }).toBe(emitted[3]!);
      await expect(page.getByTestId("code-no-target")).toBeHidden();
      return;
    }
    const candidates: string[] = [];
    for (const m of text.matchAll(/(^|[^A-Za-z0-9_$.])([A-Za-z_$][A-Za-z0-9_$]{2,})\s*\(/gm)) {
      const name = m[2]!;
      if (!candidates.includes(name)) candidates.push(name);
      if (candidates.length >= 40) break;
    }
    let target: { name: string; fn: number } | null = null;
    for (const name of candidates) {
      const res = await fetch(`${API}/api/search/functions?q=${encodeURIComponent(name)}`);
      if (!res.ok) continue;
      const page1 = (await res.json()) as { rows: { fn: number; name: string | null }[] };
      const exact = page1.rows.filter((r) => r.name === name);
      if (exact.length > 0 && String(exact[0]!.fn) !== before && (await wordPoint(page, name)) !== null) {
        target = { name, fn: exact[0]!.fn };
        break;
      }
    }
    expect(target, "the fixture should contain a call to a named function").not.toBeNull();

    const point = await wordPoint(page, target!.name);
    await page.mouse.dblclick(point!.x, point!.y);
    await expect(page.getByTestId("disasm-fold")).toContainText(/fn \d+/, { timeout: WAIT });
    await expect
      .poll(async () => selectedFn(page), { timeout: WAIT })
      .not.toBe(before);

    // Whatever it navigated to must actually carry that name.
    const now = await selectedFn(page);
    const meta = (await (await fetch(`${API}/api/fn/${now!}`)).json()) as {
      name?: string | null; overlayName?: string | null; acceptedName?: string | null;
    };
    expect([meta.name, meta.overlayName, meta.acceptedName]).toContain(target!.name);
  });
});

