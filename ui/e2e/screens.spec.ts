// ui/e2e/screens.spec.ts — spec 26 L4's acceptance for the screens tree.
//
// Same discipline as graph.spec.ts: never a hard-coded module id and never a
// hard-coded row count. What the tree must show is computed from the SAME
// route the pane calls (`GET /api/screens`), so the test states a property of
// the view rather than a snapshot of one fixture — and a fixture bundle that
// contains no screens at all skips with its reason stated, rather than
// asserting something vacuous or, worse, silently passing.
//
// Runs against the throwaway fixture rig (ui/e2e/prepare-fixture.mjs, ports
// via HBC2JS_E2E_PORT_BASE) — never the owner's live :7331/:4173.
import { test, expect, type APIRequestContext } from "@playwright/test";

const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 10_000;
const PORT = process.env["HBC2JS_E2E_PORT_BASE"] ?? "7341";
const API = process.env["PW_API_BASE"] ?? `http://127.0.0.1:${PORT}`;

interface ScreenRow {
  readonly mod: number;
  readonly label: string;
  readonly kind: "screen" | "navigator";
  readonly children: readonly number[];
  readonly navigatesTo: readonly { readonly mod: number; readonly confidence: "points-to" | "by-name" }[];
}
interface ScreensPage {
  readonly screens: readonly ScreenRow[];
  readonly total: number;
  readonly computing?: boolean;
}

/** `GET /api/screens`, polled until the segregation it derives from settles
 *  (the same wait the pane's own query does). `null` when the route is not
 *  registered or the project has no segregated tree. */
async function screens(request: APIRequestContext): Promise<ScreensPage | null> {
  for (let i = 0; i < 60; i++) {
    const res = await request.get(`${API}/api/screens`);
    if (!res.ok()) return null;
    const page = (await res.json()) as ScreensPage;
    if (page.computing !== true) return page;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

test("the Screens group renders a hierarchy, not a flat list", async ({ page, request }) => {
  const data = await screens(request);
  test.skip(data === null, "GET /api/screens unavailable in this rig");
  const parents = (data as ScreensPage).screens.filter((s) => s.children.length > 0);
  test.skip(parents.length === 0, "this fixture bundle has no screen that owns another");
  await page.goto("/");
  const group = page.locator('[data-group="seg:screens"]');
  await expect(group).toBeVisible({ timeout: WAIT });
  const parent = parents[0]!;
  const child = parent.children[0]!;
  const parentRow = page.locator(`[data-module="${parent.mod}"]`);
  const childRow = page.locator(`[data-module="${child}"]`);
  await expect(parentRow).toBeVisible({ timeout: WAIT });
  await expect(childRow).toBeVisible({ timeout: WAIT });
  // The hierarchy is visible as indentation: a child sits deeper than its
  // parent, which is exactly what a flat list cannot show.
  const padOf = async (loc: typeof parentRow): Promise<number> =>
    Number.parseFloat((await loc.evaluate((el) => getComputedStyle(el).paddingLeft)).replace("px", ""));
  expect(await padOf(childRow)).toBeGreaterThan(await padOf(parentRow));
});

test("a navigation arrow opens the target screen in the centre pane", async ({ page, request }) => {
  const data = await screens(request);
  test.skip(data === null, "GET /api/screens unavailable in this rig");
  const from = (data as ScreensPage).screens.find((s) => s.navigatesTo.length > 0);
  test.skip(from === undefined, "this fixture bundle has no screen with a navigation edge");
  await page.goto("/");
  const row = page.locator(`[data-module="${from!.mod}"]`);
  await expect(row).toBeVisible({ timeout: WAIT });
  await row.click();
  const arrow = page.locator(`[data-nav-from="${from!.mod}"]`).first();
  await expect(arrow).toBeVisible({ timeout: WAIT });
  const target = Number(await arrow.getAttribute("data-nav-to"));
  await arrow.click();
  await expect(page.locator(`[data-module="${target}"]`)).toHaveAttribute("class", /bg-surface-2/, { timeout: WAIT });
});

// (todo, spec 26 L4's own allowance) — `test.fixme` is Playwright's todo:
// reported, never silently skipped.
test.fixme("by-name edges are dashed", () => {
  // The rn-template-0.72 rig has no react-navigation route registry, so no
  // by-name candidate can be produced to render. The rule itself is enforced
  // in tests/gate/ui/screens-model.test.ts (provenance survives the
  // projection) and in tests/ui-server/screens.test.ts (only the points-to
  // index produces a "resolved" edge).
});
