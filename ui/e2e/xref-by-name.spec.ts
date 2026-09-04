// ui/e2e/xref-by-name.spec.ts — spec 17 §14.1's `who-calls-by-name`
// surfaced as the Xrefs tab's "Callers by name (heuristic)" section
// (docs/UI.md "Xrefs"). A new spec file, same as align.spec.ts, so this
// does not collide with concurrent work in smoke.spec.ts; runs against the
// SAME throwaway server (:7341/:7342, ui/e2e/playwright.config.ts) as the
// other two suites — never 7331/4173.
//
// Never hard-codes an fn id or a candidate list: it selects whichever
// function the tree opens first (deterministic, same helper smoke.spec.ts
// uses), reads the SAME /api/fn/:fn/callers and /api/xref/who-calls-by-name
// the UI itself calls, and asserts the UI matches that ground truth in
// whichever of the three states (hidden / empty-or-ambiguous / candidates)
// it lands in — the same "assert against the live API, never a hard-coded
// expectation" discipline align.spec.ts uses for the linemap.
import { test, expect, type Locator, type Page } from "@playwright/test";

const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 10_000;
const API = process.env["PW_API_BASE"] ?? "http://127.0.0.1:7341";

interface WhoCalls {
  readonly total: number;
}

interface ByNameResult {
  readonly rows: readonly { readonly fn: number; readonly callerName: string | null; readonly name: string }[];
  readonly names: readonly { readonly ambiguous: boolean; readonly why?: string }[];
}

/** Same as smoke.spec.ts's helper: the first module is already open, so a
 *  blind click would toggle it closed rather than open it. */
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

test.describe("Xrefs tab: by-name caller candidates (spec 17 §14.1)", () => {
  test("the heuristic section matches the API's hidden/empty/ambiguous/candidates state for the selected fn", async ({ page, request }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    const fnId = Number(await firstFn.getAttribute("data-fn"));
    expect(Number.isInteger(fnId)).toBe(true);

    await page.getByRole("tab", { name: "Xrefs" }).click();

    const callers = (await (await request.get(`${API}/api/fn/${fnId}/callers`)).json()) as WhoCalls;
    const byName = (await (await request.get(`${API}/api/xref/who-calls-by-name`, { params: { fn: fnId } })).json()) as ByNameResult;

    const header = page.getByText("Callers by name (heuristic)", { exact: false });

    if (callers.total > 0 && byName.rows.length === 0) {
      // Hidden: exact callers already answered, heuristic scan found
      // nothing — no reason to grow a pointless extra section.
      await expect(header).toHaveCount(0);
      return;
    }

    await expect(header).toBeVisible({ timeout: WAIT });

    if (byName.rows.length === 0) {
      const ambiguous = byName.names.find((n) => n.ambiguous);
      if (ambiguous !== undefined && ambiguous.why !== undefined) {
        // Ambiguous: an explanation, never an empty candidate list.
        await expect(page.getByText(ambiguous.why, { exact: false })).toBeVisible({ timeout: WAIT });
      } else {
        await expect(page.getByText("no by-name candidates", { exact: false })).toBeVisible({ timeout: WAIT });
      }
      return;
    }

    // At least one candidate: it renders as a heuristic row, marked
    // candidates-only, and jumps to the caller exactly like an exact
    // caller row does.
    await expect(page.getByText("candidates only", { exact: false })).toBeVisible({ timeout: WAIT });
    const target = byName.rows[0]!;
    const row = page.locator(`button[data-fn="${target.fn}"]`);
    await expect(row).toBeVisible({ timeout: WAIT });
    await row.click();

    await page.getByRole("tab", { name: "Context" }).click();
    const fnLabel = page.locator("span.w-28", { hasText: /^fn$/ });
    await expect(fnLabel).toBeVisible({ timeout: WAIT });
    const fnValue = fnLabel.locator("xpath=following-sibling::span[1]");
    await expect(fnValue).toHaveText(String(target.fn), { timeout: WAIT });
  });
});
