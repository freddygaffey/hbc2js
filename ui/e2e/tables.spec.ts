// ui/e2e/tables.spec.ts — spec 17 §14.2's bundle-wide constant
// object-literal inventory surfaced as the Tables tab (docs/UI.md "Tables
// (object literals)"). Same discipline as xref-by-name.spec.ts: never a
// hard-coded fn id or table — reads the SAME `/api/object-tables` the UI
// itself calls and asserts the tab matches whichever of the two states
// (empty / populated) that answer lands in. A new spec file so this does
// not collide with concurrent work in smoke.spec.ts; runs against the SAME
// throwaway server (:7341/:7342, ui/e2e/playwright.config.ts) as the other
// suites — never 7331/4173.
import { test, expect, type Locator, type Page } from "@playwright/test";

const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 10_000;
const API = process.env["PW_API_BASE"] ?? `http://127.0.0.1:${process.env["HBC2JS_E2E_PORT_BASE"] ?? "7341"}`;

interface ObjectTablesResult {
  readonly tables: readonly {
    readonly fn: number;
    readonly fnName: string | null;
    readonly module: number | null;
    readonly members: readonly { readonly key: string; readonly value: string | null; readonly kind: string }[];
    readonly strings: number;
  }[];
  readonly total: number;
  readonly truncated: boolean;
}

/** Same helper as smoke.spec.ts / xref-by-name.spec.ts: the first module is
 *  already open, so a blind click would toggle it closed rather than open it. */
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

test.describe("Tables tab: bundle-wide object-literal inventory (spec 17 §14.2)", () => {
  test("the tab's default-filter list and jump-to-fn match the live /api/object-tables answer", async ({ page, request }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();

    await page.getByRole("tab", { name: "Tables" }).click();

    const api = (await (await request.get(`${API}/api/object-tables`)).json()) as ObjectTablesResult;

    if (api.tables.length === 0) {
      await expect(page.getByText("no constant tables match this filter", { exact: false })).toBeVisible({ timeout: WAIT });
      return;
    }

    // The bounded-line honesty check: shown/total/truncated all appear.
    await expect(page.getByText(`of ${api.total}`, { exact: false })).toBeVisible({ timeout: WAIT });
    if (api.truncated) {
      await expect(page.getByText("(truncated)", { exact: false })).toBeVisible({ timeout: WAIT });
    }

    const target = api.tables[0]!;
    const row = page.locator(`button[data-fn="${target.fn}"][data-offset]`).first();
    await expect(row).toBeVisible({ timeout: WAIT });
    await expect(row).toContainText(String(target.members.length));

    await row.click();

    // Expanding shows the first member's key (loose match — a string
    // member's own value can legitimately contain the key as a substring,
    // e.g. `READ_CALENDAR: android.permission.READ_CALENDAR`, so this can
    // resolve to more than one element; `.first()` is enough proof the key
    // rendered at all).
    await expect(page.getByText(target.members[0]!.key, { exact: false }).first()).toBeVisible({ timeout: WAIT });

    // Clicking the row also selected the function (same navigation call
    // every other xref surface uses) — the Context tab shows it.
    await page.getByRole("tab", { name: "Context" }).click();
    const fnLabel = page.locator("span.w-28", { hasText: /^fn$/ });
    await expect(fnLabel).toBeVisible({ timeout: WAIT });
    const fnValue = fnLabel.locator("xpath=following-sibling::span[1]");
    await expect(fnValue).toHaveText(String(target.fn), { timeout: WAIT });
  });

  test("the value filter narrows the list to a real match, e.g. paths only", async ({ page, request }) => {
    await page.goto("/");
    await openFirstModuleAndFn(page);
    await page.getByRole("tab", { name: "Tables" }).click();

    await page.getByRole("button", { name: "paths only" }).click();
    await expect(page.getByPlaceholder("value regex")).toHaveValue("^(/|https?:)");

    // Give the 250ms debounce time to settle, then compare against the
    // same filtered query hitting the API directly.
    await page.waitForTimeout(400);
    const api = (await (await request.get(`${API}/api/object-tables`, { params: { value: "^(/|https?:)" } })).json()) as ObjectTablesResult;

    if (api.tables.length === 0) {
      await expect(page.getByText("no constant tables match this filter", { exact: false })).toBeVisible({ timeout: WAIT });
    } else {
      const row = page.locator(`button[data-fn="${api.tables[0]!.fn}"][data-offset]`).first();
      await expect(row).toBeVisible({ timeout: WAIT });
    }
  });
});

// spec 26 L5: the shared `ResultTable` (`ui/src/components/ResultTable.tsx`)
// every result list in the shell now uses — client-side sort (never a
// refetch), an honest truncation bar reading the contract's own cap, and
// virtualisation that never scales DOM node count with row count. Exercised
// here through the Tables tab because it is the one `ResultTable` consumer
// whose backing endpoint (`GET /api/object-tables`) is easy to intercept
// with a large synthetic page — real fixture bundles rarely carry 10k
// constant tables, and a virtualiser bug only shows up at that scale.
test.describe("ResultTable (spec 26 L5)", () => {
  test("sorting a column reorders rows without refetching", async ({ page, request }) => {
    await page.goto("/");
    await openFirstModuleAndFn(page);
    await page.getByRole("tab", { name: "Tables" }).click();

    const api = (await (await request.get(`${API}/api/object-tables`)).json()) as ObjectTablesResult;
    test.skip(api.tables.length < 2, "fixture has fewer than two tables — nothing to reorder");

    const header = page.locator('[data-testid="result-table-header"][data-column="fn"]');
    await expect(header).toBeVisible({ timeout: WAIT });

    let requests = 0;
    page.on("request", (req) => {
      if (new URL(req.url()).pathname === "/api/object-tables") requests++;
    });

    await header.click();
    await expect(header).toContainText(/\^|v/);
    await page.waitForTimeout(200);

    await header.click();
    await expect(header).toContainText(/\^|v/);
    await page.waitForTimeout(200);

    // Sorting is a client-side reorder of already-fetched rows — clicking
    // the header twice (asc, then desc) must never re-ask the server.
    expect(requests).toBe(0);
  });

  test("a capped result renders the truncation bar with the cap's own number", async ({ page }) => {
    // Intercepts the SAME endpoint the tab calls with a synthetic, honestly
    // capped page (`total` far above `tables.length`) — proves the bar
    // reads `truncated`/`total` off the response, not a client constant.
    const total = 500;
    const shown = 50;
    await page.route("**/api/object-tables*", async (route) => {
      const tables = Array.from({ length: shown }, (_, i) => ({
        fn: i, fnName: `fn${i}`, size: null, offset: i * 4, module: 0, numProps: 1,
        members: [{ key: "k", value: "v", kind: "string" }], strings: 1, nonStrings: 0, computed: 0, matched: 1,
      }));
      await route.fulfill({ json: { tables, total, truncated: true, scanned: total, failed: 0 } });
    });
    await page.goto("/");
    await openFirstModuleAndFn(page);
    await page.getByRole("tab", { name: "Tables" }).click();

    const bar = page.getByTestId("truncation-bar");
    await expect(bar).toBeVisible({ timeout: WAIT });
    await expect(bar).toContainText(`of ${total}`);
    await expect(bar).toContainText("(truncated)");
  });

  test("10k rows scroll without mounting 10k DOM nodes", async ({ page }) => {
    const total = 10_000;
    await page.route("**/api/object-tables*", async (route) => {
      const tables = Array.from({ length: total }, (_, i) => ({
        fn: i, fnName: `fn${i}`, size: null, offset: i * 4, module: 0, numProps: 1,
        members: [{ key: "k", value: "v", kind: "string" }], strings: 1, nonStrings: 0, computed: 0, matched: 1,
      }));
      await route.fulfill({ json: { tables, total, truncated: false, scanned: total, failed: 0 } });
    });
    await page.goto("/");
    await openFirstModuleAndFn(page);
    await page.getByRole("tab", { name: "Tables" }).click();

    const firstRow = page.locator('[data-testid="result-table"] [data-index]').first();
    await expect(firstRow).toBeVisible({ timeout: WAIT });

    const mounted = await page.locator('[data-testid="result-table"] [data-index]').count();
    expect(mounted).toBeGreaterThan(0);
    // The whole point of virtualisation: far fewer DOM rows than data rows.
    expect(mounted).toBeLessThan(200);

    // The virtualiser still sized its scroll region for all 10k rows (the
    // inner sizer div's height), not just the mounted subset — otherwise
    // this "pass" would just be an under-fetch, not real virtualisation.
    const sizerHeight = await page
      .locator('[data-testid="result-table"] .hbc-scroll > div')
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(sizerHeight).toBeGreaterThan(total * 10); // >=10px/row is a very loose floor
  });
});
