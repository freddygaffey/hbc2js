# Spec 25 — UI graph view (neighbourhood-scoped call/module graph)

Status: implemented (2026-09-05). Owner-requested feature; the library pick was
delegated to the orchestrator on 2026-09-05 and is recorded as **D28**.

## 1. Goal

Give the analyst the picture the panes cannot: *what calls this, what does it
call, what does this module sit between*. A graph, drawn from the same
`ui-server` routes the Xrefs pane already uses, in the same theme tokens as
the rest of the shell — no new palette, no new global layout.

Non-goal: a whole-bundle map. Spec 19 §4 and spec 17 §14 already cut
`module-graph`; the scale answer is **the contract, not the renderer**
(spec 20 §2.4). The UI draws **neighbourhoods**: one function and its direct
callers/callees, or one module and its direct deps/consumers, expandable one
node at a time.

## 2. Library decision (D28)

**React Flow (`@xyflow/react`, MIT) + `@dagrejs/dagre` (MIT)**, both pinned
exactly in `ui/package.json`. elkjs is rejected: EPL-2.0 is a weak copyleft and
the tree stays cleanly MIT-compatible. This is spec 20 §2.4's own
recommendation; the owner delegated the ratification (QUEUE Needs-Fred item 5).

## 3. Modes

Driven by the current selection (`ui/src/state/selection.ts`), one at a time:

1. **Call neighbourhood** (`fn` selection, or any selection carrying an `fn`).
   Focus node = the function; incoming edges from `GET /api/fn/{fn}/callers`,
   outgoing edges from `GET /api/fn/{fn}/callees`, plus
   `GET /api/xref/who-calls-by-name?fn=` candidates drawn as **dashed** edges
   in `text-muted` — they are name matches on a `property-get`, never resolved
   edges (spec 17 §14.1), and the graph must never let them read as proven.
2. **Module edges** (`module` selection). Focus node = the module; edges from
   `GET /api/module/{id}` (`deps` out, `dependents` in). Direct edges only.
3. **CFG of the selected function** — **SHIPPED (2026-09-05, spec 26 L9)**.
   `GET /api/fn/{fn}/cfg` (`src/ui-server/cfg.ts`, registered in
   `routes.ts`) projects `src/cfg`'s own block graph: blocks with their
   function-relative byte range, instruction count, terminator and SOURCE
   LINE span, normal + exception edges, and the exception regions. The mode
   is entered by the `near` semantic-zoom level (§5b), not by a separate
   selection: nodes become `blk:<id>` (entry = focus), and a **click selects
   the listing lines the block was compiled from** through the shared
   `select()`. `lodCard` (§5b) remains the fallback when the route declines
   the function.

Only the focus node's neighbours are ever fetched. **Expand** re-roots nothing:
clicking a neighbour's "+" fetches *that* node's callers/callees and merges
them into the drawn graph; **focus** (click) makes the node the new focus and
pushes a breadcrumb, without touching the shared selection; **double-click**
selects the function/module in the selection store, which jumps the code pane
(and, because the pane follows a *new* selection, re-roots the graph there).

## 4. Where it lives

- Code: `ui/src/graph/` (`GraphPane.tsx`, `model.ts`, `layout.ts`,
  `nodes.tsx`, `store.ts`). Nothing outside `ui/src/graph/` gains graph logic.
- Surface: a **Graph** tab in the existing right-pane tab strip
  (`ui/src/panes/RightPane.tsx`, `RightPanel` union in
  `ui/src/actions/store.ts`) — the shell's existing navigation, so `App.tsx` is
  untouched. The pane has a **maximise** toggle that renders the same canvas as
  a full-window overlay (`fixed inset-0`), because a call neighbourhood does
  not read well at 280 px.
- Actions (registered UI-side in `ui/src/actions/registry.ts`, so the shared
  `src/ui-core` registry and its tests are untouched):
  `graph.open` (open the Graph tab on the current selection),
  `graph.expand` (expand the focus node one hop),
  `graph.focus` (re-focus the graph on the current selection).
  `view.graph` in `src/ui-core/actions.ts` stays `when: () => false` — flipping
  it inverts the assertion in `tests/ui-core/actions.test.ts`, which an
  implementation task must never do (AGENT-BRIEF); its `ActionApi.openGraph`
  binding in the UI now opens this pane, so enabling it later is a one-line
  change plus that test's update, routed by the orchestrator.

## 5. Rendering rules

- **Nodes** are custom React Flow components reading existing tokens only
  (`bg-surface`, `border-border`, `text-text`, `text-text-muted`,
  `text-sev-*`, `rounded-ui`, the mono font). Content: display name, byte size,
  module chip, and a severity dot when a finding names the node's function.
  The focus node is outlined in `accent`.
- **Layout**: `@dagrejs/dagre`, `rankdir: "TB"`, callers above, focus in the
  middle, callees below. Layout is pure (`layout.ts`) and runs on every model
  change; no physics, no animation loop.
- **Level of detail**: below zoom `0.55` node labels are hidden and the node
  renders as a plain token-coloured box (`data-lod="min"`), so a wide
  neighbourhood stays legible.
- **Cap**: `GRAPH_NODE_CAP = 300`. When the model would exceed it, the extra
  nodes are dropped and an honest truncation bar (the same idiom and wording
  shape as the listing's, `ui/src/panes/CenterPane.tsx`) says how many are not
  drawn. Never a silent trim.
- Pan/zoom/fit come from React Flow (`fitView`, `Controls`), themed by tokens.

## 5a. Interaction: drag, highlight, reset, follow (burs 8, 10 — 2026-09-05)

**Drag.** `nodesDraggable` is on. A drag writes the node's new absolute
position into `ui/src/graph/store.ts`'s `dragPositions` (a
`ReadonlyMap<string, Point>`), which `GraphPane` overlays on top of
`layoutModel`'s pure dagre positions when placing each React Flow node. The
map is scoped to the CURRENT neighbourhood: `rootGraph`, `focusGraphNode` and
`graphBack` all clear it, because an offset for a node that is no longer even
drawn is meaningless. It is not otherwise persisted (no localStorage, no
server round-trip) — "until reset" per the bur, not "forever".

**Reset view.** A toolbar button (`data-graph-reset`) calls
`resetGraphView()` (drops every drag offset, so the pane falls back to the
pure dagre layout on the next render) and then re-runs React Flow's own
`fitView`. The two are sequenced with a `requestAnimationFrame` so `fitView`
sees the DOM after the drag offsets are gone, not before.

**Highlight.** `ui/src/graph/model.ts` exports a pure `neighbourSet(model,
id)`: the node's id plus every node one edge away, and the ids of those
edges — used identically for two triggers:

- **Hover** (bur 8): `onNodeMouseEnter`/`onNodeMouseLeave` write
  `store.ts`'s `hoverNode`.
- **Follow** (bur 10, below): a resolved call-site match, when hovering is
  not active. Hover always wins when both fire.

Whichever id is active, every node/edge in its `neighbourSet` gets a
`highlighted` flag (an `accent` ring, `ring-2 ring-accent` — a token, not a
new colour) and everything else gets `dimmed` (`opacity-40` / a reduced edge
`opacity`, never a colour change — `tests/gate/ui/tokens.test.ts` only
forbids literal colours, not opacity). Nothing is highlighted when no id is
active — the pane looks exactly as it did before this bur.

**Follow toggle (bur 10).** A toolbar toggle (`data-graph-follow`, persisted
to `localStorage` under `hbc2js.graph.follow` with the same try/catch idiom
as `ui/src/activity/store.ts` — a private-browsing tab degrades to
session-only, never a crash). **Default: ON.** Reasoning: (1) Fred asked for
the feature directly ("the section of code the user has selected should be
visible ... in the graph view") — an opt-in default would ship the bur as
invisible; (2) ON is exactly the re-root effect `GraphPane` already had
before this bur (any selection with an `fn` re-roots the graph) — defaulting
ON changes no existing behaviour, only adds the ability to turn it off and
the call-site highlight.

With `follow` on:
- A NEW listing selection (`ui/src/state/selection.ts`'s `useSelection`,
  read-only) re-roots the graph on the selected function — `rootGraph`, the
  same path §3's mode dispatch already used; unchanged by this bur.
- If the selection is an **identifier inside the graph's own focus
  function** whose text matches one of the already-drawn neighbours (a call
  site's callee), `model.ts`'s `calleeNodeForSelection(model, selection)`
  resolves it to that neighbour's node id, and it gets bur 8's highlight.
  This is deliberately narrow: it never re-roots on a random identifier
  (that stays targetForSelection's job, gated on `sel.fn`), and it never
  fabricates an edge the model does not already draw — a callee outside the
  one-hop neighbourhood (not expanded) is not highlighted, honestly, rather
  than guessed at.

With `follow` off, both behaviours stop: the graph stays exactly where it
is regardless of what the listing selects, until the toggle is switched back
on (at which point the next selection change re-roots normally).

**Keybinding — shipped with bur 9 (§5b):** `graph.followToggle` is bound to
`g f` ("graph follow") in all three presets, and lives in the SHARED registry
so the chord is not dangling in a shell without a graph pane.

## 5b. Semantic zoom (level of detail) — bur 9 (2026-09-05)

Fred, verbatim: *"it should have a level of recursion view - I don't know how
this would work but I think it should be kind of like a fractal: as you zoom
in you see more."* The answer is **semantic zoom**: the same neighbourhood,
re-read at three grains. Nothing here fetches anything new — every level is a
pure function of the model the pane has already fetched, so "zoom in" can
never become "load the bundle".

### The three levels

| level | nodes | edges | what it answers |
|---|---|---|---|
| `far` | **modules** (`bundleByModule`) | module-to-module **bundles**, one per pair, carrying a `weight` (how many function edges it stands for) and drawn thicker/labelled | where does this neighbourhood live |
| `mid` | the **functions** of the neighbourhood (today's model, unchanged) | resolved edges + dashed by-name candidates | who calls what |
| `near` | the same functions, with the **focus opened up** | unchanged | what is inside the one I am on |

`far` is derived, not fetched: every drawn function folds into `mod:<n>` when
the contract reported its module, and **stays its own node when it did not** —
a function of unknown module is never guessed into somebody else's box. An
edge inside one module becomes a self-loop and is dropped: intra-module edges
are exactly what the `mid` level is for. The bundle node reports `members`
(the fold count) and the bundled edge reports `weight`, both on screen — the
same "never a silent trim" rule as the node cap (§5).

`near` **landed with spec 26 L9 (2026-09-05).** It draws mode 3: the focus
function's own **block graph**, fetched from `GET /api/fn/{fn}/cfg` at this
level only (`mid`/`far` never pay for it) and turned into the ordinary
`GraphModel` by `buildCfgModel` in `ui/src/graph/model.ts`, so the shipped
renderer, the §5c frame-aware layout, the drag offsets, the hover highlight
and the truncation bar all work on it unchanged — the UI adds no CFG logic.
`modelForLevel(model, level, cfgModel)` is the one place that chooses.

The **fallback is `lodCard`**, exactly as this section always promised: when
the route DECLINES the function (a project served with no `--hbc`, or an
analysis that refused it) `near` still renders the focus node as a taller
**card** (`NODE_H_NEAR`) whose body is `lodCard(model, focusId)` — its drawn
callers and callees by label, capped at `LOD_CARD_CAP = 8` with an honest
`+N more`, plus the line `blocks: no CFG for this function`. The card's
extra height is reserved only when the card is what is drawn; a CFG entry
block is an ordinary node.

The e2e test that asserted the degraded stand-in
(`the near level opens the focus into a card, honest about the missing CFG`)
became `the near level falls back to the focus card when the CFG route
declines`, which makes the SAME honesty assertion over the fallback path,
with the route stubbed to 404. Nothing else in §5b moved.

### Thresholds, and why they are hysteretic

```ts
lodLevel(zoom: number, prev: LodLevel = "mid"): "far" | "mid" | "near"
```

Pure, total, in `ui/src/graph/model.ts`. Boundaries `LOD_THRESHOLDS =
{ farMid: 0.5, midNear: 1.6 }`; a level flips **up** only past
`t * (1 + LOD_HYSTERESIS)` and **down** only below `t * (1 - LOD_HYSTERESIS)`
(`LOD_HYSTERESIS = 0.12`). Inside that band the function returns `prev`, so a
viewport resting on a boundary — a trackpad, a `fitView`, a nudge — cannot
oscillate between two layouts. A jump straight past two boundaries still
lands on the right level: each boundary is evaluated independently, not by
stepping. `Number.isFinite(zoom) === false` returns `prev` rather than
guessing.

`LOD_NOMINAL_ZOOM = { far: 0.35, mid: 0.9, near: 2 }` is where each level is
"at home". Every nominal zoom derives its own level from **any** previous
level (a gate test asserts it), which is what lets the level be *set*
directly — the toolbar control, `graph.lodCycle`, "reset view" — and then
zoom the viewport there without the derived level fighting the set one.

**Only a user gesture moves the level.** `GraphPane` derives the level in
React Flow's `onMove` **only when the reported source event is non-null**;
React Flow passes `null` for its own programmatic moves (`fitView`, the
Controls +/- buttons). That is deliberate and load-bearing: a neighbourhood
fitted into the 280 px side panel already lands below `0.5` zoom, and a pane
fitting *itself* must never silently re-draw at a different level. Wheel and
pinch zoom, `g z`, and the `lod:<level>` toolbar button are the only things
that change it.

### What auto-expands and collapses

`setGraphLod(level)` (store) does the bookkeeping, through the same
`expandGraphNode` / `collapseGraphNode` the "+" affordance uses:

- **into `far`**: every extra hop is collapsed (a module bundle does not draw
  per-function hops anyway) after parking at most `LOD_EXPAND_CAP = 8` of
  them in `lodStashed`.
- **out of `far`**: exactly those parked refs are re-expanded, capped again
  at `LOD_EXPAND_CAP`.
- **`mid` <-> `near`**: nothing expands. `near` opens the *focus node*, it
  does not pull neighbours' hops in behind it. This is a deliberate bound:
  auto-expanding on zoom-in would make the node set a function of the
  viewport, which breaks both the analyst's mental model and the pane's
  promise that a hop is fetched only when asked for.

So the ceiling on a level change is: at most `LOD_EXPAND_CAP` restored hops,
each still subject to `GRAPH_NODE_CAP = 300` and its truncation bar. Never
the whole bundle.

### Interaction with §5a (drag, follow, reset)

- **Drag offsets** are per node id and survive a level change only where the
  id does. `far` re-keys function nodes to `mod:<n>`, so a dragged function
  simply has no offset in the bundled view and the pure dagre layout places
  the module box; coming back to `mid` restores the offset. Nothing is
  cleared by a level change — the neighbourhood did not change.
- **Follow** (bur 10) is orthogonal: a follow-driven re-root keeps the
  current level and records it as `rootLod`. The level is a property of the
  viewport (where the analyst is standing), not of the neighbourhood.
- **Reset view** returns to `rootLod` — the level the neighbourhood was
  rooted at — drops the drag offsets, and re-fits at
  `LOD_NOMINAL_ZOOM[rootLod]` (`fitView` with `minZoom === maxZoom`), so the
  level the toolbar reports and the zoom the viewport is at cannot disagree.
  `rootGraph` / `focusGraphNode` / `graphBack` all set `rootLod` to the level
  in force when they ran.

### Actions and keys

`graph.followToggle` (`g f`) and `graph.lodCycle` (`g z`) are registered in
the SHARED registry (`src/ui-core/actions.ts`) and bound in all three presets
— unlike `graph.open`/`graph.focus`/`graph.expand`, which stay UI-side (§4),
because a preset chord must name an action every shell knows. Both are backed
by new `ActionApi` methods (`toggleGraphFollow`, `cycleGraphLod`) that a
shell without a graph pane implements as no-ops. Neither inverts
`view.graph`'s `when: () => false` (§4) — that assertion is untouched.

### Acceptance tests (by name)

`tests/ui-core/graph-model.test.ts` (pure, in the root gate):

- `lodLevel: the three levels, by viewport zoom`
- `lodLevel: hysteresis - a zoom sitting on a boundary keeps the level it had`
- `lodLevel: every nominal zoom derives its own level (a set level cannot fight the viewport)`
- `nextLodLevel cycles far -> mid -> near -> far`
- `bundleByModule: functions fold into their module, parallel edges bundle with a weight`
- `bundleByModule: a function with no known module is never guessed into someone else's`
- `bundleByModule: an intra-module edge is not drawn as a self-loop at far`
- `modelForLevel: mid and near draw the fetched model, far bundles it`
- `lodCard: the near level's focus card lists drawn callers/callees, bounded`
- `lodCard: a node with no drawn edges says so rather than inventing any`

`tests/gate/ui/keymap-default.test.ts`:

- `every shipped preset binds graph.followToggle and graph.lodCycle`

`ui/e2e/graph.spec.ts` (Playwright, fixture rig only):

- `semantic zoom: cycling the level folds the neighbourhood into module bundles and back`
- `semantic zoom: the near level opens the focus into a card, honest about the missing CFG`
- `semantic zoom: reset view returns to the level the neighbourhood was rooted at`

### Needs Fred (not guessed here)

1. **Art direction of the level transition.** Today a level change is an
   instant re-layout (plus the 120 ms height/opacity settle in `graph.css`).
   A true "fractal" reading would cross-fade the module box into the
   functions it contains, or grow them out of it. That is animation design,
   not engineering, and the shell has no motion language yet.
2. **Whether `far` should re-root on the module** (fetch `/api/module/{id}`
   deps/dependents, i.e. mode 2) instead of bundling what is already drawn.
   Bundling is honest and free; re-rooting shows more, but changes what "the
   neighbourhood" means mid-gesture. Deliberately not guessed.
3. **The `near` level's contents now L9 has landed**: it draws the blocks
   ALONE (the callers/callees are one zoom level away, at `mid`, and mixing
   two node kinds on one canvas reads badly). Blocks plus the neighbourhood
   in one view is still available as a design choice — not guessed here.

## 5c. Layout for the frame — bur 11 (2026-09-05)

Fred, verbatim: *"The graph view is starting to come together, but it needs to
be improved. Right now, you can't see everything when zoomed out because it is
too wide for the small frame that you have. So making it arrange to be more
space efficient would be better."*

The docked pane is ~280 px wide and much taller than wide. Plain dagre lays a
rank of eight callees out as one ~1600 px row, so `fitView` scaled the whole
neighbourhood to ~0.17 and nothing was legible — the graph was arranged for a
frame it does not have. §5c makes the layout a function of the **measured**
frame.

### The algorithm (`ui/src/graph/layout.ts`, pure)

`layoutGraph(model, { focusHeight?, frame? })` runs in two stages:

1. **Rank with dagre, keep only its ordering.** `rankdir: "TB"` as before, so
   callers stay above the focus and callees below it (§5's reading direction
   is unchanged, and a unit test asserts it survives wrapping). All nodes of
   one dagre rank share one centre `y`, which is what groups them; inside a
   rank they keep dagre's left-to-right order, i.e. its crossing
   minimisation — the part of dagre worth keeping.
2. **Re-pack each rank into rows that fit the frame.** A rank of `n` nodes
   becomes `ceil(n / columns)` rows, each row centred in the content box,
   rows separated by `ROW_GAP = 10` and ranks by `RANK_GAP = 34` (the larger,
   so a wrapped rank still reads as one rank). The bounding box is
   `columns * nodeWidth + (columns - 1) * GAP_X + 2 * MARGIN` wide, which is
   `<= frame.width` by construction.

### Choosing `columns` and `nodeWidth` (`chooseGrid`)

The objective is the only thing that matters for this bur: **how wide a node
is on screen after `fitView`**, i.e. `nodeWidth * scale` where
`scale = min(1, frameW / boxW, frameH / boxH)`. `chooseGrid` evaluates every
column count from 1 up to the most the frame can hold at `NODE_W_MIN = 104`
(the narrowest a mono label stays readable) and takes the best; ties go to the
fewest wrapped rows (an unwrapped rank reads as a rank, so wrapping is only
paid for when it buys legibility), then to the box aspect closest to the
frame's. `nodeWidth` is the frame's width divided by the chosen columns,
clamped to `[NODE_W_MIN, NODE_W]` — never wider than the preferred 176, never
narrower than legible.

This is what makes one code path serve both frames. Focus with two callers and
eight callees:

| frame | columns | node width | box | fit scale | node on screen |
|---|---|---|---|---|---|
| 280 x 700 (docked) | 1 | 176 | 192 x 648 | 1.00 | 176 px |
| 1280 x 760 (maximised) | 4 | 176 | 756 x 270 | 1.00 | 176 px |

The tall narrow pane gets a single legible column; the window gets a compact
grid. Before this section both were one 1616 px row.

### Measuring, and what happens without a measurement

`GraphPane` observes the canvas element with a `ResizeObserver` and rounds to
whole pixels (a sub-pixel resize must not re-run the layout forever). Until it
reports — the first render — `frame` is `null` and `layoutGraph` returns
**exactly the pre-bur-11 dagre placement**, with `columns: 0` to say so; a
degenerate frame (zero or `NaN` width) degrades the same way rather than
producing `NaN` positions. A frame change that actually changes the grid
(`columns:nodeWidth`, not every pixel of a drag) re-runs `fitView`, and is
skipped while §5a drag offsets exist — those positions are the analyst's and a
resize must not yank the view out from under them.

`fitView` padding drops from `0.2` to `0.08` (`FIT_PADDING`): the layout now
sizes itself for the frame, so a large padding would spend the legibility the
wrapped grid just bought back.

### What it must not break, and does not

- **LOD (§5b)** — the level still picks the model; `near`'s taller focus card
  is passed through as `focusHeight` and the rank packer reserves its height
  (unit test: no node overlaps the card's band).
- **Drag / Reset (§5a)** — `dragPositions` still overlay the computed
  positions; Reset still drops them and re-fits.
- **Follow (§5a)** and the hover highlight are untouched: they key off node
  ids, not geometry.
- Node **counts** are untouched — the layout moves boxes, it never adds or
  drops one, which is why every existing acceptance test still holds.

### Acceptance tests (by name)

`tests/ui-core/graph-layout.test.ts` (pure, no browser): a wide rank wraps to
fit the docked pane; nodes never go below `NODE_W_MIN`; a roomy frame keeps
`NODE_W` and does not wrap; callers stay above and callees below after
wrapping; no two boxes overlap; the `near` card's band is clear; no frame
reproduces the old dagre layout; a degenerate frame never yields `NaN`;
positions stay inside the reported box; the layout is deterministic; every
frame width produces a layout that fits it.

`ui/e2e/graph.spec.ts` ("Graph tab: layout for the frame (bur 11)"): with a
stubbed eight-callee rank, every node's rendered box sits inside the **docked**
pane's box at fit-to-view and the flow-space x-extent is `<=` the pane width;
and maximising re-measures the frame and takes more columns than the docked
pane did (proof the `ResizeObserver` drives the layout).

### Needs Fred (art direction, defaults picked here)

- **Orientation stays top-down in every frame.** A very wide frame could flow
  left-to-right instead, but §5 fixes callers-above-focus-above-callees as the
  reading direction and an implementation task does not quietly invert it.
- `NODE_W_MIN = 104`, `GAP_X = 12`, `ROW_GAP = 10`, `RANK_GAP = 34`,
  `MARGIN = 8`, `FIT_PADDING = 0.08` — sensible defaults, not measured against
  a designer's grid.
- Wrapped rows are **centred**, not left-aligned, and are not drawn as
  swimlanes (no rank label, no separator). A rank of eight over two rows reads
  as one group today only by proximity.

## 6. Acceptance tests

**Model (`tests/ui-core/graph-model.test.ts`, node:test, runs in the root
gate).** `ui/src/graph/model.ts` imports only *types* from
`ui/src/contracts.ts`, so the pure half is testable with no browser and no
`ui/node_modules`: focus + callers-above/callees-below, by-name candidates as
`byName` edges that never outrank a resolved edge, a native/unknown neighbour
(string `fn`) drawn but not navigable, the 300-node cap dropping the overflow
and reporting `hidden` honestly (with edges to capped-away nodes dropped), and
module mode drawing direct deps/consumers only.

**Pane (`ui/e2e/graph.spec.ts`, Playwright)** against the throwaway fixture rig
(`ui/e2e/prepare-fixture.mjs`; ports via `HBC2JS_E2E_PORT_BASE`) — never the
owner's live rig:

1. **draws exactly the selected function's neighbourhood**: the drawn node id
   set equals the set computed from the SAME routes the pane calls
   (`/callers`, `/callees`, `who-calls-by-name`), the focus is marked, and the
   breadcrumb starts at length 1. Ground truth from the API, never a
   hard-coded count.
2. **expand adds that neighbour's hop and never re-roots** (focus and
   breadcrumb unchanged).
3. **click re-focuses**: the clicked neighbour becomes the focus, the
   breadcrumb grows to 2, and the graph is now *its* neighbourhood.
4. **cap**: 300 nodes drawn and the truncation bar states the 51 that are not.
5. **level of detail**: at full detail labels are drawn; zooming out past the
   threshold flips every node to `data-lod="min"`.
6. **maximise** toggles the pane over the window and back.
7. **drag** (bur 8): a node's `data-graph-x`/`data-graph-y` (its React Flow
   `positionAbsoluteX`/`Y`, exposed on the node div for exactly this
   assertion) change after a mouse-down/move/up drag; clicking **Reset view**
   restores them to their pre-drag values exactly (the pure dagre layout is
   deterministic for an unchanged model).
8. **hover highlight** (bur 8): hovering a node sets
   `data-graph-highlighted="true"` on it and every node one edge away, and
   `data-graph-dimmed="true"` on a node that is neither — exercised over a
   stubbed two-hop graph (901's own callees) so there is a node (902) that is
   provably NOT a neighbour of the hovered one (901).
9. **follow ON/OFF** (bur 10): selecting a different function in the listing
   changes the graph's focus node when `data-graph-follow="true"`, and
   leaves it unchanged when the toggle has been clicked to `"false"`.

Tests 2–4 drive **stubbed** xref responses (`page.route`): the rn-template
fixture has no resolved `fn -> fn` call edges at all (its callees are
`require` module refs and `computed-callee` unknowns; its callers are all
`unknownInScope`), so expansion, re-focus and the cap cannot be exercised
against it honestly. The routes are the contract; the pane is what is under
test. Tests 1, 5, 6 and 9 run against the real fixture server (test 9 only
needs two DIFFERENT functions to exist, which the fixture already has); 7 and
8 run against the real server too (7 only needs a small drawn neighbourhood,
8 stubs a two-hop graph the same way tests 2–4 do).

**Model.** `neighbourSet` (a node plus its incident edges/neighbours, nothing
further) and `calleeNodeForSelection` (an identifier inside the focus
function matching a drawn neighbour's label, `null` for a different
function/non-identifier/no match/the focus itself) are covered in
`tests/ui-core/graph-model.test.ts` alongside the original five.

Plus `npm run typecheck` in `ui/` (React Flow and dagre are typed; no `any`).

## 7. Out of scope / follow-ups

- ~~**CFG mode**~~ — **DONE (2026-09-05, spec 26 L9)**: `GET /api/fn/{fn}/cfg`
  (`src/ui-server/cfg.ts`, `tests/ui-server/cfg.test.ts`), drawn by the `near`
  level (§3 mode 3, §5b). `FocusCard` in `ui/src/graph/nodes.tsx` survives as
  the decline-path fallback.
- Whole-bundle map, clustering, force layout, WebGL (sigma.js) — held in
  reserve per spec 20 §2.4; nothing here needs them.
- Enabling `view.graph` in `src/ui-core/actions.ts` (see §4).
- Persisting graph state across sessions; export to SVG/PNG.
