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
3. **CFG of the selected function** — **NOT SHIPPED**. `src/ui-server/routes.ts`
   publishes no per-function CFG route (the closest is
   `/api/fn/{fn}/disasm`, a text listing, and `/api/fn/{fn}/linemap`). Adding
   a `cfg` resource is a server + `McpResources` change with its own contract
   shape and tests, which is out of scope for this task; it stays a follow-up
   (see §7).

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

**Keybinding (not yet registered — `ui/src/actions/registry.ts` is another
agent's file this task; no `graph.*` action is registered there at all yet,
per §4). Recommend a `graph.followToggle` action bound to `g f` (mnemonic
"graph follow"), once that file is free and `graph.open`/`graph.focus`/
`graph.expand` (§4) are registered alongside it.

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

- **CFG mode** — needs a read-only `/api/fn/{fn}/cfg` route over the existing
  `src/cfg` block graph, with `tests/ui-server/**` coverage. Follow-up.
- Whole-bundle map, clustering, force layout, WebGL (sigma.js) — held in
  reserve per spec 20 §2.4; nothing here needs them.
- Enabling `view.graph` in `src/ui-core/actions.ts` (see §4).
- Persisting graph state across sessions; export to SVG/PNG.
