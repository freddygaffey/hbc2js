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
    const target = source.locator(".cm-line").nth(fileLine - 1);
    await target.scrollIntoViewIfNeeded();
    await target.click();

    const highlighted = disasm.locator(".hbc-selected-line");
    await expect(highlighted).toHaveCount(1, { timeout: WAIT });
    await expect(highlighted).toContainText(`[@ ${offset}]`);
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
