// ui/e2e/graph-open-in-listing.spec.ts — bur 14 (docs/UI-BURS.md #14):
// "double-clicking an item in the graph should jump to the line of code
// where it is". `onNodeDoubleClick` (../src/graph/GraphPane.tsx) already
// pushed a `fn`/`module` selection before this fix, but nothing visible
// happened: the listing's own scroll/highlight machinery only fires once
// the selection is applied AND the listing is actually on screen, and a
// maximised graph pane sits `fixed inset-0 z-50` over the whole window
// (same discipline as ui/e2e/graph.spec.ts: never a hard-coded fn id, the
// expected neighbourhood is read from the SAME routes the pane calls).
//
// Runs against the throwaway fixture rig (ui/e2e/prepare-fixture.mjs,
// ports via HBC2JS_E2E_PORT_BASE) — never the owner's live :7331/:4173.
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 15_000;
const PORT = process.env["HBC2JS_E2E_PORT_BASE"] ?? "7341";
const API = process.env["PW_API_BASE"] ?? `http://127.0.0.1:${PORT}`;

interface Edges {
  readonly rows: readonly { readonly fn: number | string; readonly name: string | null }[];
}

/** The node ids ui/src/graph/model.ts will mint for `fn`'s neighbourhood
 *  (same computation as ui/e2e/graph.spec.ts's `expectedNodeIds`, trimmed
 *  to what this file needs: how many REAL function neighbours there are). */
async function realFnNeighbours(request: APIRequestContext, fn: number): Promise<number[]> {
  const [callers, callees] = await Promise.all([
    request.get(`${API}/api/fn/${fn}/callers`).then((r) => r.json() as Promise<Edges>),
    request.get(`${API}/api/fn/${fn}/callees`).then((r) => r.json() as Promise<Edges>),
  ]);
  const rows = <T>(v: unknown): readonly T[] => (Array.isArray(v) ? (v as readonly T[]) : []);
  const out = new Set<number>();
  for (const row of [...rows<Edges["rows"][number]>(callers.rows), ...rows<Edges["rows"][number]>(callees.rows)]) {
    if (typeof row.fn === "number" && row.fn !== fn) out.add(row.fn);
  }
  return [...out];
}

async function openFirstModuleAndFn(page: Page): Promise<Locator> {
  const firstModule = page.locator("[data-module]").first();
  await expect(firstModule).toBeVisible({ timeout: WAIT });
  const firstFn = page.locator("[data-fn]").first();
  if (!(await firstFn.isVisible().catch(() => false))) await firstModule.click();
  await expect(firstFn).toBeVisible({ timeout: WAIT });
  return firstFn;
}

interface Pick {
  readonly row: Locator;
  readonly fn: number;
  readonly neighbours: number[];
}

/** A function in the open tree with at least one REAL function neighbour
 *  (caller or callee) — the interesting case for "double-click a neighbour
 *  node lands on ITS definition". Falls back to the first row (neighbours
 *  empty; the test then exercises the focus node instead). */
async function pickFnWithRealNeighbour(page: Page, request: APIRequestContext): Promise<Pick> {
  const rows = page.locator("[data-fn]");
  const n = Math.min(await rows.count(), 25);
  let first: Pick | null = null;
  for (let i = 0; i < n; i += 1) {
    const row = rows.nth(i);
    const fn = Number(await row.getAttribute("data-fn"));
    if (!Number.isInteger(fn)) continue;
    const neighbours = await realFnNeighbours(request, fn);
    first ??= { row, fn, neighbours };
    if (neighbours.length > 0) return { row, fn, neighbours };
  }
  if (first === null) throw new Error("no function rows in the tree");
  return first;
}

async function openGraphFor(page: Page, row: Locator): Promise<void> {
  await row.click();
  await page.getByRole("tab", { name: "Graph" }).click();
  await expect(page.locator("[data-graph-pane]")).toBeVisible({ timeout: WAIT });
}

/** Same zoom-in-until-full-detail dance as ui/e2e/graph.spec.ts: a
 *  neighbourhood fitted into the side panel starts below the
 *  level-of-detail threshold, where the double-click target is not drawn
 *  richly enough to click reliably. Leaves the pane MAXIMISED on return,
 *  which is exactly the state this bug needs (bur 14: a maximised graph
 *  hides the listing behind it). */
async function zoomToFullDetailMaximised(page: Page): Promise<void> {
  const pane = page.locator("[data-graph-pane]");
  if ((await pane.getAttribute("data-graph-maximised")) !== "true") await page.locator("[data-graph-maximise]").click();
  await expect(pane).toHaveAttribute("data-graph-maximised", "true");
  const first = page.locator("[data-graph-node]").first();
  const zoomIn = page.locator(".react-flow__controls-zoomin");
  for (let i = 0; i < 8; i += 1) {
    if ((await first.getAttribute("data-lod")) === "full") return;
    await zoomIn.click();
  }
  await expect(first).toHaveAttribute("data-lod", "full", { timeout: WAIT });
}

/** React Flow pans with a CSS transform, so a node outside the viewport can
 *  never be double-clicked — pick one that is already on screen. */
async function nodeInViewport(page: Page, selector: string): Promise<Locator | null> {
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  for (const node of await page.locator(selector).all()) {
    const box = await node.boundingBox();
    if (box === null) continue;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    if (cx > 8 && cy > 8 && cx < size.width - 8 && cy < size.height - 8) return node;
  }
  return null;
}

const codeView = (page: Page): Locator => page.getByTestId("code-view").first();

test.describe("Graph double-click opens the listing (bur 14)", () => {
  // Fixed (docs/BUGS.md "graph: dblclick on a non-focus neighbour node
  // while maximised never un-maximises", 2026-09-05, resolved): this test
  // was previously masked by a selector bug that could pick an "ext:m:N"
  // external-reference node instead of a real "fn:N" node (fixed in the
  // same commit, see nodeInViewport's selector below) -- with a real
  // function neighbour now reliably targeted, the un-maximise assertion
  // failed for real. Root cause: `onNodeClick` re-rooted the graph on the
  // clicked node synchronously, relaying it out from under the second half
  // of the double-click before the browser could synthesize `dblclick`
  // (see the `pendingFocusRef` comment in GraphPane.tsx).
  test("dblclick a neighbour node: listing shows that fn, definition line selected and in view", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    await openFirstModuleAndFn(page);
    const { row, neighbours } = await pickFnWithRealNeighbour(page, request);
    test.skip(neighbours.length === 0, "fixture has no function with a real caller/callee to target");
    await openGraphFor(page, row);
    await zoomToFullDetailMaximised(page);

    // A non-focus FUNCTION node, on screen, naming one of the real
    // neighbours. The graph can also draw "ext:m:N" nodes for external
    // module references (bur 14 fixture-dependent); those are not
    // dblclick-to-listing targets, so the selector must exclude them
    // rather than relying on the id-shape assertion below to skip them
    // after the fact — with `:not([data-graph-focus])` alone, picking an
    // "ext:" node here is a real observed flake, not a hypothetical one.
    const nonFocusFn = page.locator("[data-graph-node^='fn:']:not([data-graph-focus='true'])");
    await expect(nonFocusFn.first()).toBeVisible({ timeout: WAIT });
    const target = await nodeInViewport(page, "[data-graph-node^='fn:']:not([data-graph-focus='true'])");
    expect(target, "a neighbour function node should be on screen at full detail").not.toBeNull();
    const targetId = await target!.getAttribute("data-graph-node");
    expect(targetId).toMatch(/^fn:\d+$/);
    const targetFn = Number(targetId!.slice(3));

    await target!.dblclick();

    // The graph pane un-maximises so the listing is actually visible
    // (bur 14's root cause: `fixed inset-0 z-50` hid it before this fix).
    await expect(page.locator("[data-graph-pane]")).toHaveAttribute("data-graph-maximised", "false", { timeout: WAIT });
    await expect(codeView(page)).toBeVisible({ timeout: WAIT });
    await expect(codeView(page).locator(".cm-content")).not.toBeEmpty({ timeout: WAIT });

    // The listing landed on the double-clicked function... (scoped to the
    // breadcrumb: the graph pane itself is still on screen, un-maximised
    // rather than unmounted, and also renders a "fn N" label on the node
    // and in its own header, so a page-wide text search is ambiguous).
    await expect(page.getByTestId("breadcrumbs").getByText(`fn ${targetFn}`, { exact: true })).toBeVisible({ timeout: WAIT });
    // ...with a real line selected (its definition line)...
    await expect
      .poll(async () => Number(await codeView(page).getAttribute("data-selected-line")), { timeout: WAIT })
      .toBeGreaterThan(0);
    // ...and that line decorated and scrolled into view, not off-screen.
    const decorated = page.locator(".hbc-selected-line").first();
    await expect(decorated).toBeVisible({ timeout: WAIT });
    await expect(decorated).toBeInViewport();
  });

  test("dblclick the focus node while maximised still reveals the listing", async ({ page, request }) => {
    await page.goto("/");
    const row = await openFirstModuleAndFn(page);
    const { fn } = await pickFnWithRealNeighbour(page, request);
    void fn;
    await openGraphFor(page, row);
    await zoomToFullDetailMaximised(page);

    const focus = page.locator("[data-graph-focus='true']");
    await expect(focus).toBeVisible({ timeout: WAIT });
    await focus.dblclick();

    await expect(page.locator("[data-graph-pane]")).toHaveAttribute("data-graph-maximised", "false", { timeout: WAIT });
    await expect(codeView(page)).toBeVisible({ timeout: WAIT });
    const decorated = page.locator(".hbc-selected-line").first();
    await expect(decorated).toBeVisible({ timeout: WAIT });
    await expect(decorated).toBeInViewport();
  });
});
