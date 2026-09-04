// ui/e2e/graph.spec.ts — spec 25 §6's acceptance tests for the Graph tab.
// Same discipline as xref-by-name.spec.ts: never a hard-coded fn id and
// never a hard-coded node count — the expected neighbourhood is computed
// from the SAME routes the pane itself calls (/api/fn/:fn/callers,
// /callees, /api/xref/who-calls-by-name), so the test states a property of
// the view, not a snapshot of one fixture.
//
// Runs against the throwaway fixture rig (ui/e2e/prepare-fixture.mjs,
// ports via HBC2JS_E2E_PORT_BASE) — never the owner's live :7331/:4173.
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 10_000;
const PORT = process.env["HBC2JS_E2E_PORT_BASE"] ?? "7341";
const API = process.env["PW_API_BASE"] ?? `http://127.0.0.1:${PORT}`;

interface Edges {
  readonly rows: readonly { readonly fn: number | string; readonly name: string | null }[];
  readonly total: number;
}
interface ByName {
  readonly rows: readonly { readonly fn: number; readonly callerName: string | null }[];
}

/** The node ids ui/src/graph/model.ts will mint for `fn`'s neighbourhood. */
async function expectedNodeIds(request: APIRequestContext, fn: number): Promise<Set<string>> {
  const [callers, callees, byName] = await Promise.all([
    request.get(`${API}/api/fn/${fn}/callers`).then((r) => r.json() as Promise<Edges>),
    request.get(`${API}/api/fn/${fn}/callees`).then((r) => r.json() as Promise<Edges>),
    request.get(`${API}/api/xref/who-calls-by-name`, { params: { fn } }).then((r) => r.json() as Promise<ByName>),
  ]);
  // A route that answers `{reason}` (a 400 — e.g. the bytecode-global fn 0,
  // or a by-name scan the server declines) contributes nothing, exactly as
  // the pane's own failed query does.
  const rows = <T>(v: unknown): readonly T[] => (Array.isArray(v) ? (v as readonly T[]) : []);
  const ids = new Set<string>([`fn:${fn}`]);
  for (const row of [...rows<Edges["rows"][number]>(callers.rows), ...rows<Edges["rows"][number]>(callees.rows)]) {
    ids.add(typeof row.fn === "number" ? `fn:${row.fn}` : `ext:${row.name ?? String(row.fn)}`);
  }
  for (const row of rows<ByName["rows"][number]>(byName.rows)) ids.add(`fn:${row.fn}`);
  return ids;
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
  readonly ids: Set<string>;
}

/** A function in the open tree whose neighbourhood satisfies `prefer` —
 *  by default "more than just the focus node", the graph's interesting
 *  case. The interaction tests ask for a SMALL neighbourhood instead: React
 *  Flow's `fitView` zooms a wide one below the level-of-detail threshold,
 *  where labels and the "+" affordance are deliberately not drawn. Falls
 *  back to any neighbourhood, then to the first function. */
async function pickFnWithNeighbours(
  page: Page,
  request: APIRequestContext,
  prefer: (size: number) => boolean = (size) => size > 1,
): Promise<Pick> {
  const rows = page.locator("[data-fn]");
  const n = Math.min(await rows.count(), 25);
  let any: Pick | null = null;
  let first: Pick | null = null;
  for (let i = 0; i < n; i += 1) {
    const row = rows.nth(i);
    const fn = Number(await row.getAttribute("data-fn"));
    if (!Number.isInteger(fn)) continue;
    const ids = await expectedNodeIds(request, fn);
    first ??= { row, fn, ids };
    if (ids.size > 1) any ??= { row, fn, ids };
    if (prefer(ids.size)) return { row, fn, ids };
  }
  const chosen = any ?? first;
  if (chosen === null) throw new Error("no function rows in the tree");
  return chosen;
}

/** Small enough that the whole neighbourhood fits on screen at full detail. */
const SMALL = (size: number): boolean => size > 1 && size <= 8;

async function openGraphFor(page: Page, row: Locator): Promise<void> {
  await row.click();
  await page.getByRole("tab", { name: "Graph" }).click();
  await expect(page.locator("[data-graph-pane]")).toBeVisible({ timeout: WAIT });
}

/** A neighbourhood fitted into the 280 px side panel starts BELOW the
 *  level-of-detail threshold (spec 25 §5) — labels and the "+" affordance
 *  are deliberately not drawn there. Every interaction test therefore
 *  maximises the pane and zooms in until the nodes are at full detail,
 *  which is also what an analyst does. */
async function zoomToFullDetail(page: Page): Promise<void> {
  const pane = page.locator("[data-graph-pane]");
  if ((await pane.getAttribute("data-graph-maximised")) !== "true") await page.locator("[data-graph-maximise]").click();
  const first = page.locator("[data-graph-node]").first();
  const zoomIn = page.locator(".react-flow__controls-zoomin");
  for (let i = 0; i < 8; i += 1) {
    if ((await first.getAttribute("data-lod")) === "full") return;
    await zoomIn.click();
  }
  await expect(first).toHaveAttribute("data-lod", "full", { timeout: WAIT });
}

/** React Flow pans with a CSS transform, so a node outside the viewport can
 *  never be scrolled to — pick one that is already on screen. Returns null
 *  when the zoomed-in viewport happens to show only the focus. */
async function firstNodeInViewport(page: Page, selector: string): Promise<Locator | null> {
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  for (const node of await page.locator(selector).all()) {
    const box = await node.boundingBox();
    if (box === null) continue;
    // Playwright clicks an element's CENTRE, so that is what has to be on
    // screen (a node clipped at the edge is still clickable).
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    if (cx > 8 && cy > 8 && cx < size.width - 8 && cy < size.height - 8) return node;
  }
  return null;
}

test.describe("Graph tab: call neighbourhood (spec 25)", () => {
  test("draws exactly the selected function's neighbourhood, focus marked", async ({ page, request }) => {
    await page.goto("/");
    await openFirstModuleAndFn(page);
    const { row, fn, ids } = await pickFnWithNeighbours(page, request);
    await openGraphFor(page, row);

    const nodes = page.locator("[data-graph-node]");
    await expect(nodes).toHaveCount(ids.size, { timeout: WAIT });
    const drawn = await nodes.evaluateAll((els) => els.map((e) => e.getAttribute("data-graph-node")));
    expect(new Set(drawn)).toEqual(ids);

    const focused = page.locator('[data-graph-focus="true"]');
    await expect(focused).toHaveCount(1);
    await expect(focused).toHaveAttribute("data-graph-node", `fn:${fn}`);
    // The breadcrumb starts at the focus.
    await expect(page.locator("[data-graph-trail]")).toHaveAttribute("data-graph-trail", "1");
  });

  // The rn-template fixture has NO resolved fn->fn call edges (its callees
  // are `require` module refs and `computed-callee` unknowns, its callers
  // are all `unknownInScope`), so expand/focus/cap cannot be exercised
  // against it honestly. They are exercised against STUBBED xref responses
  // instead — the routes are the contract, and the pane is what is under
  // test here, not the fixture's call graph.
  async function stubCallGraph(page: Page, callees: ReadonlyMap<number, readonly number[]>): Promise<void> {
    await page.route("**/api/fn/*/callers*", (route) =>
      route.fulfill({ json: { rows: [], total: 0, truncated: false, unknownInScope: 0 } }));
    await page.route("**/api/xref/who-calls-by-name*", (route) =>
      route.fulfill({ json: { rows: [], names: [], excludedModule: null } }));
    await page.route("**/api/fn/*/callees*", (route) => {
      const fn = Number(new URL(route.request().url()).pathname.split("/")[3]);
      const rows = (callees.get(fn) ?? []).map((n) => ({ fn: n, name: `stub${n}`, size: 10, file: null, line: null, kind: "call" }));
      return route.fulfill({ json: { rows, total: rows.length, truncated: false } });
    });
  }

  test("expanding a neighbour adds ITS hop and never re-roots", async ({ page, request }) => {
    await page.goto("/");
    await openFirstModuleAndFn(page);
    const { row, fn } = await pickFnWithNeighbours(page, request);
    await stubCallGraph(page, new Map([[fn, [901, 902]], [901, [911, 912]]]));
    await openGraphFor(page, row);

    const nodes = page.locator("[data-graph-node]");
    await expect(nodes).toHaveCount(3, { timeout: WAIT });
    await zoomToFullDetail(page);
    await page.locator('[data-graph-node="fn:901"] [data-graph-expand]').click();
    // 901's own callees join the drawing; the focus is untouched.
    await expect(nodes).toHaveCount(5, { timeout: WAIT });
    await expect(page.locator('[data-graph-focus="true"]')).toHaveAttribute("data-graph-node", `fn:${fn}`);
    await expect(page.locator("[data-graph-trail]")).toHaveAttribute("data-graph-trail", "1");
  });

  test("clicking a neighbour re-focuses the graph and grows the breadcrumb", async ({ page, request }) => {
    await page.goto("/");
    await openFirstModuleAndFn(page);
    const { row, fn } = await pickFnWithNeighbours(page, request);
    await stubCallGraph(page, new Map([[fn, [901, 902]], [901, [911, 912]]]));
    await openGraphFor(page, row);
    await expect(page.locator("[data-graph-node]")).toHaveCount(3, { timeout: WAIT });
    await zoomToFullDetail(page);

    await page.locator('[data-graph-node="fn:901"]').click();
    await expect(page.locator("[data-graph-trail]")).toHaveAttribute("data-graph-trail", "2");
    const focused = page.locator('[data-graph-focus="true"]');
    await expect(focused).toHaveCount(1);
    await expect(focused).toHaveAttribute("data-graph-node", "fn:901");
    // Re-rooted on 901: its own two callees are the neighbourhood now.
    await expect(page.locator("[data-graph-node]")).toHaveCount(3, { timeout: WAIT });
  });

  test("over the cap: 300 nodes drawn and the truncation bar says how many are not", async ({ page, request }) => {
    await page.goto("/");
    await openFirstModuleAndFn(page);
    const { row, fn } = await pickFnWithNeighbours(page, request);
    const many = Array.from({ length: 350 }, (_, i) => 1000 + i);
    await stubCallGraph(page, new Map([[fn, many]]));
    await openGraphFor(page, row);

    await expect(page.locator("[data-graph-node]")).toHaveCount(300, { timeout: WAIT });
    // focus + 350 callees = 351, so 51 are not drawn — stated, never silent.
    await expect(page.locator("[data-graph-truncated]")).toHaveAttribute("data-graph-truncated", "51");
    await expect(page.getByText("51 more not drawn", { exact: false })).toBeVisible();
  });

  test("level of detail: zooming out drops the labels", async ({ page, request }) => {
    await page.goto("/");
    await openFirstModuleAndFn(page);
    const { row } = await pickFnWithNeighbours(page, request);
    await openGraphFor(page, row);

    await zoomToFullDetail(page);
    const first = page.locator("[data-graph-node]").first();
    await expect(first).toHaveAttribute("data-lod", "full");
    const zoomOut = page.locator(".react-flow__controls-zoomout");
    for (let i = 0; i < 8; i += 1) await zoomOut.click();
    await expect(first).toHaveAttribute("data-lod", "min", { timeout: WAIT });
  });

  test("maximise toggles the graph over the window and back", async ({ page, request }) => {
    await page.goto("/");
    await openFirstModuleAndFn(page);
    const { row } = await pickFnWithNeighbours(page, request);
    await openGraphFor(page, row);

    const pane = page.locator("[data-graph-pane]");
    await expect(pane).toHaveAttribute("data-graph-maximised", "false");
    await page.locator("[data-graph-maximise]").click();
    await expect(pane).toHaveAttribute("data-graph-maximised", "true");
    await page.locator("[data-graph-maximise]").click();
    await expect(pane).toHaveAttribute("data-graph-maximised", "false");
  });
});

// Bur 8 (2026-09-05): draggable nodes, hover/selection highlight, reset view.
// Bur 10 (2026-09-05): the follow toggle.
test.describe("Graph tab: drag, highlight, reset, follow (burs 8, 10)", () => {
  async function stubTwoHops(page: Page, fn: number): Promise<void> {
    await page.route("**/api/fn/*/callers*", (route) =>
      route.fulfill({ json: { rows: [], total: 0, truncated: false, unknownInScope: 0 } }));
    await page.route("**/api/xref/who-calls-by-name*", (route) =>
      route.fulfill({ json: { rows: [], names: [], excludedModule: null } }));
    const callees = new Map([[fn, [901, 902]], [901, [911, 912]]]);
    await page.route("**/api/fn/*/callees*", (route) => {
      const target = Number(new URL(route.request().url()).pathname.split("/")[3]);
      const rows = (callees.get(target) ?? []).map((n) => ({ fn: n, name: `stub${n}`, size: 10, file: null, line: null, kind: "call" }));
      return route.fulfill({ json: { rows, total: rows.length, truncated: false } });
    });
  }

  test("nodes are draggable, and Reset view puts them back exactly", async ({ page, request }) => {
    await page.goto("/");
    await openFirstModuleAndFn(page);
    const { row, fn } = await pickFnWithNeighbours(page, request, SMALL);
    await openGraphFor(page, row);
    await zoomToFullDetail(page);
    // zoomToFullDetail zooms toward the viewport centre, which can push a
    // small neighbourhood's edge nodes off screen; re-fit at the current
    // zoom so every node is clickable again.
    await page.locator(".react-flow__controls-fitview").click();

    // Any drawn node on screen does — fitView already fit the whole (small)
    // neighbourhood, but a zoom-in step centres on the viewport middle, so a
    // node at the edge of a wide-ish neighbourhood can still end up
    // off-screen; pick one that Playwright can actually click, same idiom
    // as the cap/expand tests above.
    const target = await firstNodeInViewport(page, "[data-graph-node]");
    if (target === null) throw new Error("no graph node is on screen to drag");
    const before = { x: await target.getAttribute("data-graph-x"), y: await target.getAttribute("data-graph-y") };

    const box = (await target.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 90, cy + 60, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(async () => `${await target.getAttribute("data-graph-x")},${await target.getAttribute("data-graph-y")}`)
      .not.toBe(`${before.x},${before.y}`);

    await page.locator("[data-graph-reset]").click();
    await expect(target).toHaveAttribute("data-graph-x", before.x ?? "", { timeout: WAIT });
    await expect(target).toHaveAttribute("data-graph-y", before.y ?? "", { timeout: WAIT });
  });

  test("hovering a node highlights its neighbours and dims the rest", async ({ page, request }) => {
    await page.goto("/");
    await openFirstModuleAndFn(page);
    const { row, fn } = await pickFnWithNeighbours(page, request);
    await stubTwoHops(page, fn);
    await openGraphFor(page, row);
    await expect(page.locator("[data-graph-node]")).toHaveCount(3, { timeout: WAIT });
    await zoomToFullDetail(page);
    await page.locator('[data-graph-node="fn:901"] [data-graph-expand]').click();
    await expect(page.locator("[data-graph-node]")).toHaveCount(5, { timeout: WAIT });

    await page.locator('[data-graph-node="fn:901"]').hover();
    await expect(page.locator('[data-graph-node="fn:901"]')).toHaveAttribute("data-graph-highlighted", "true");
    await expect(page.locator(`[data-graph-node="fn:${fn}"]`)).toHaveAttribute("data-graph-highlighted", "true");
    await expect(page.locator('[data-graph-node="fn:911"]')).toHaveAttribute("data-graph-highlighted", "true");
    await expect(page.locator('[data-graph-node="fn:912"]')).toHaveAttribute("data-graph-highlighted", "true");
    await expect(page.locator('[data-graph-node="fn:902"]')).toHaveAttribute("data-graph-dimmed", "true");
  });

  test("follow ON (default): a new listing selection re-focuses the graph", async ({ page }) => {
    await page.goto("/");
    await openFirstModuleAndFn(page);
    const rows = page.locator("[data-fn]");
    test.skip((await rows.count()) < 2, "fixture needs at least two functions to prove re-focus");
    const fn0 = Number(await rows.nth(0).getAttribute("data-fn"));
    const fn1 = Number(await rows.nth(1).getAttribute("data-fn"));
    await openGraphFor(page, rows.nth(0));
    await expect(page.locator("[data-graph-follow]")).toHaveAttribute("data-graph-follow", "true");
    await expect(page.locator('[data-graph-focus="true"]')).toHaveAttribute("data-graph-node", `fn:${fn0}`);

    await rows.nth(1).click();
    await expect(page.locator('[data-graph-focus="true"]')).toHaveAttribute("data-graph-node", `fn:${fn1}`, { timeout: WAIT });
  });

  test("follow OFF: a new listing selection leaves the graph where it is", async ({ page }) => {
    await page.goto("/");
    await openFirstModuleAndFn(page);
    const rows = page.locator("[data-fn]");
    test.skip((await rows.count()) < 2, "fixture needs at least two functions to prove the graph stays put");
    const fn0 = Number(await rows.nth(0).getAttribute("data-fn"));
    await openGraphFor(page, rows.nth(0));
    await page.locator("[data-graph-follow]").click();
    await expect(page.locator("[data-graph-follow]")).toHaveAttribute("data-graph-follow", "false");

    await rows.nth(1).click();
    await page.waitForTimeout(200);
    await expect(page.locator('[data-graph-focus="true"]')).toHaveAttribute("data-graph-node", `fn:${fn0}`);
  });
});

// Bur 9 (docs/UI-BURS.md #9; spec 25 §5b): semantic zoom - "as you zoom in
// you see more". far = modules with bundled edges, mid = the functions,
// near = the focus opened into a card (the CFG's stand-in until spec 26 L9).
test.describe("Graph tab: semantic zoom (bur 9)", () => {
  /** Two callees that share ONE module, so the `far` level provably folds
   *  them into a single module node with a weight-2 bundled edge. The module
   *  id is deliberately far outside the fixture's own range. */
  const BUNDLE_MOD = 4242;

  async function stubOneModule(page: Page): Promise<void> {
    await page.route("**/api/fn/*/callers*", (route) =>
      route.fulfill({ json: { rows: [], total: 0, truncated: false, unknownInScope: 0 } }));
    await page.route("**/api/xref/who-calls-by-name*", (route) =>
      route.fulfill({ json: { rows: [], names: [], excludedModule: null } }));
    await page.route("**/api/fn/*/callees*", (route) => {
      const rows = [901, 902].map((n) => ({ fn: n, name: `stub${n}`, size: 10, module: BUNDLE_MOD, file: null, line: null, kind: "call" }));
      return route.fulfill({ json: { rows, total: rows.length, truncated: false } });
    });
  }

  test("cycling the level folds the neighbourhood into module bundles and back", async ({ page, request }) => {
    await page.goto("/");
    await openFirstModuleAndFn(page);
    const { row } = await pickFnWithNeighbours(page, request);
    await stubOneModule(page);
    await openGraphFor(page, row);
    const pane = page.locator("[data-graph-pane]");
    const lod = page.locator("[data-graph-lod]");

    // The pane opens at `mid`: the functions, as spec 25 has always drawn.
    await expect(pane).toHaveAttribute("data-graph-lod-level", "mid");
    await expect(page.locator("[data-graph-node]")).toHaveCount(3, { timeout: WAIT });
    await expect(page.locator('[data-graph-node="fn:901"]')).toHaveCount(1);

    // A programmatic fit must NOT move the level (spec 25 §5b): the pane
    // fitting itself is not the analyst zooming.
    await page.locator(".react-flow__controls-fitview").click();
    await expect(pane).toHaveAttribute("data-graph-lod-level", "mid");

    // mid -> near -> far -> mid.
    await lod.click();
    await expect(lod).toHaveAttribute("data-graph-lod", "near");
    await lod.click();
    await expect(lod).toHaveAttribute("data-graph-lod", "far");
    // far: the two functions of one module are ONE node, and it says so.
    await expect(page.locator(`[data-graph-node="mod:${BUNDLE_MOD}"]`)).toHaveAttribute("data-graph-members", "2", { timeout: WAIT });
    await expect(page.locator('[data-graph-node="fn:901"]')).toHaveCount(0);
    await lod.click();
    await expect(lod).toHaveAttribute("data-graph-lod", "mid");
    await expect(page.locator('[data-graph-node="fn:901"]')).toHaveCount(1, { timeout: WAIT });
  });

  test("the near level opens the focus into a card, honest about the missing CFG", async ({ page, request }) => {
    await page.goto("/");
    await openFirstModuleAndFn(page);
    const { row, fn } = await pickFnWithNeighbours(page, request);
    await stubOneModule(page);
    await openGraphFor(page, row);
    await page.locator("[data-graph-maximise]").click();

    await page.locator("[data-graph-lod]").click();
    await expect(page.locator("[data-graph-lod]")).toHaveAttribute("data-graph-lod", "near");
    const focus = page.locator(`[data-graph-node="fn:${fn}"]`);
    await expect(focus).toHaveAttribute("data-graph-card", "true", { timeout: WAIT });
    // The card lists the drawn callees and does not pretend to have the CFG
    // that spec 26 L9 will add.
    await expect(focus.locator("[data-graph-card-body]")).toContainText("stub901");
    await expect(focus.locator("[data-graph-card-body]")).toContainText("CFG pending");
    // No neighbour becomes a card: `near` opens ONE node, it never pulls the
    // rest of the bundle in behind it.
    await expect(page.locator('[data-graph-node="fn:901"]')).toHaveAttribute("data-graph-card", "false");
  });

  test("reset view returns to the level the neighbourhood was rooted at", async ({ page, request }) => {
    await page.goto("/");
    await openFirstModuleAndFn(page);
    const { row } = await pickFnWithNeighbours(page, request);
    await stubOneModule(page);
    await openGraphFor(page, row);
    const lod = page.locator("[data-graph-lod]");
    await expect(lod).toHaveAttribute("data-graph-lod", "mid");

    await lod.click();
    await lod.click();
    await expect(lod).toHaveAttribute("data-graph-lod", "far");
    await page.locator("[data-graph-reset]").click();
    await expect(lod).toHaveAttribute("data-graph-lod", "mid", { timeout: WAIT });
    await expect(page.locator("[data-graph-pane]")).toHaveAttribute("data-graph-lod-level", "mid");
  });
});
