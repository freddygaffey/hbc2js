// ui/e2e/align.spec.ts — source <-> disasm alignment (docs/specs/05-emitter.md
// §16, docs/UI.md "Source<->disasm alignment"). A NEW spec file rather than a
// case in smoke.spec.ts, so this landing does not collide with concurrent work
// there.
//
// The property asserted is the honest one: when a clicked source line has a
// mapped origin, the disassembly pane highlights the line for THAT byte offset
// — checked against `GET /api/fn/:fn/linemap` itself, not against a hard-coded
// line number, so the test survives any change to the fixture's bytecode.
// It never asserts that some line must be mapped: coverage is partial by
// design, and a fixture function with no mapped line is skipped, not failed.
import { test, expect, type Page } from "@playwright/test";

const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 10_000;
const API = process.env["PW_API_BASE"] ?? "http://127.0.0.1:7341";

interface LineMap {
  fn: number;
  fnStartLine: number | null;
  lines: [number, number, number, number][];
}

/** Click a WORD on `source`'s line `fileLine` (1-based), not the bare centre
 *  of `.cm-line`: that div spans the whole editor width, so on a short line
 *  the centre often lands past the text in empty space, where CodeMirror's
 *  `wordAt` finds nothing and `onIdentifier` never fires (`CodeView.tsx`).
 *  Syntax-highlighted source wraps every token in its own `span`, whose
 *  bounding box hugs the glyphs, so clicking its centre always lands on the
 *  word. */
async function clickWordOnLine(source: ReturnType<Page["getByTestId"]>, fileLine: number): Promise<void> {
  const line = source.locator(".cm-line").nth(fileLine - 1);
  await line.scrollIntoViewIfNeeded();
  const word = line.locator("span").first();
  if (await word.count() > 0) await word.click();
  else await line.click();
}

/** Open the first module, click the first function row, return its fn id. */
async function selectFirstFn(page: Page): Promise<number> {
  const firstModule = page.locator("[data-module]").first();
  await expect(firstModule).toBeVisible({ timeout: WAIT });
  const firstFn = page.locator("[data-fn]").first();
  if (!(await firstFn.isVisible().catch(() => false))) await firstModule.click();
  await expect(firstFn).toBeVisible({ timeout: WAIT });
  await firstFn.click();
  return Number(await firstFn.getAttribute("data-fn"));
}

test.describe("source <-> disasm alignment", () => {
  test("clicking a mapped source line highlights that instruction in the disassembly", async ({ page, request }) => {
    await page.goto("/");
    const fn = await selectFirstFn(page);

    const map = (await (await request.get(`${API}/api/fn/${fn}/linemap`)).json()) as LineMap;
    // Only rows for THIS function can steer this listing (a nested closure
    // printed inside it carries its own index, §16.1).
    const own = map.lines.filter((r) => r[1] === fn);
    test.skip(own.length === 0, `fn ${fn} has no mapped line — coverage is partial by design`);
    const [localLine, , offset] = own[Math.min(1, own.length - 1)]!;

    const disasm = page.getByTestId("code-view").nth(1);
    await expect(disasm).toBeVisible({ timeout: WAIT });

    // The centre pane may be showing the whole module file; rebase if so.
    const source = page.getByTestId("code-view").first();
    const fileLine = (map.fnStartLine ?? 1) + localLine - 1;
    await clickWordOnLine(source, fileLine);

    const highlighted = disasm.locator(".hbc-selected-line");
    await expect(highlighted).toHaveCount(1, { timeout: WAIT });
    await expect(highlighted).toContainText(`[@ ${offset}]`);
  });

  test("the disasm pane follows the cursor into a nested inline closure (spec 05 §16.2)", async ({ page, request }) => {
    // `rn-template-0.72` module 0 (`src/App.js`, fn 74 = `factory`) hoists no
    // sibling for its first inline closure — `_fn75` prints INSIDE fn 74's own
    // body — so fn 74's linemap carries fn 75's rows too (§16.2). Found by
    // scanning `GET /api/fn/:fn/linemap` across the bundle; if a future
    // re-render of this fixture stops nesting fn 75 here, the map lookup
    // below skips rather than asserting on a stale line number.
    await page.goto("/");
    const mod = page.locator('[data-module="0"]');
    await expect(mod).toBeVisible({ timeout: WAIT });
    const parentRow = page.locator('[data-fn="74"]');
    if (!(await parentRow.isVisible().catch(() => false))) await mod.click();
    await expect(parentRow).toBeVisible({ timeout: WAIT });
    await parentRow.click();

    const map = (await (await request.get(`${API}/api/fn/74/linemap`)).json()) as LineMap;
    const nestedRow = map.lines.find((r) => r[1] !== 74);
    test.skip(nestedRow === undefined, "fn 74 no longer carries a nested-closure row — pick another fixture fn (docs/UI.md)");
    const [localLine, childFn, offset] = nestedRow!;
    const fileLine = (map.fnStartLine ?? 1) + localLine - 1;

    const source = page.getByTestId("code-view").first();
    const disasm = page.getByTestId("code-view").nth(1);
    await expect(source).toBeVisible({ timeout: WAIT });
    await expect(disasm).toBeVisible({ timeout: WAIT });

    const header = page.getByTestId("disasm-nested-header");
    // Before the cursor reaches the nested closure's own lines, fn 74's own
    // (unmapped, this early) listing is showing: no header, no highlight.
    await expect(header).toHaveCount(0);
    await expect(disasm.locator(".hbc-selected-line")).toHaveCount(0);

    await clickWordOnLine(source, fileLine);

    await expect(header).toBeVisible({ timeout: WAIT });
    await expect(header).toContainText(`fn ${childFn}`);
    await expect(header).toContainText("fn 74");

    const highlighted = disasm.locator(".hbc-selected-line");
    await expect(highlighted).toHaveCount(1, { timeout: WAIT });
    await expect(highlighted).toContainText(`[@ ${offset}]`);

    // Clicking the header jumps straight to the child (same jump path a
    // Callees row uses, `select({kind:"fn", fn})`) — the disasm fold bar's
    // own `fn N` label, already exercised by the fold-state test below,
    // flips from the parent to the child.
    await header.click();
    await expect(page.getByTestId("disasm-fold")).toContainText(`fn ${childFn}`, { timeout: WAIT });

    // Back on fn 74's own listing, a parent-owned line returns the pane to
    // fn 74's own disassembly (no nested header).
    await parentRow.click();
    const parentOnlyRow = map.lines.find((r) => r[1] === 74);
    if (parentOnlyRow !== undefined) {
      const [pLocal] = parentOnlyRow;
      const pFileLine = (map.fnStartLine ?? 1) + pLocal - 1;
      await clickWordOnLine(source, pFileLine);
      await expect(header).toHaveCount(0, { timeout: WAIT });
    }
  });

  test("the disassembly panel keeps its fold state while the source selection moves", async ({ page }) => {
    await page.goto("/");
    await selectFirstFn(page);
    const toggle = page.getByTestId("disasm-fold");
    await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: WAIT });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    const source = page.getByTestId("code-view").first();
    await source.locator(".cm-line").nth(2).click();
    // Alignment must never re-open a panel the analyst folded away.
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});
