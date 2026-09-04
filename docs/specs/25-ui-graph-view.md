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
pushes a breadcrumb; **double-click** selects the function/module in the shared
selection store, which is what jumps the code pane.

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

## 6. Acceptance tests

`ui/e2e/graph.spec.ts`, against the throwaway fixture rig
(`ui/e2e/prepare-fixture.mjs`, ports via `HBC2JS_E2E_PORT_BASE`) — never the
owner's live rig:

1. **opens and draws the selected function's neighbourhood**: select the first
   function, open the Graph tab, assert ≥1 node and that the focus node's
   `data-graph-focus="true"` matches the selected fn; assert the node count
   agrees with the live `/api/fn/{fn}/callers` + `/callees` + by-name
   candidates the UI itself fetched (bounded by the cap) — ground truth from
   the API, never a hard-coded number.
2. **expand adds nodes**: expanding a neighbour never *reduces* the node count
   and re-roots nothing (focus is unchanged).
3. **focus change**: clicking a neighbour makes it the focus and the breadcrumb
   grows; the code pane's selection is unchanged until double-click.
4. **LOD**: zooming out past the threshold hides labels (`data-lod="min"` on
   the drawn nodes).
5. **truncation bar**: a synthetic model over the cap renders the bar with the
   hidden count (unit-checked in the pane's pure model helper via a DOM-free
   assertion in the e2e run's page context, since no fixture bundle has a
   300-neighbour function).

Plus `npm run typecheck` in `ui/` (React Flow and dagre are typed; no `any`).

## 7. Out of scope / follow-ups

- **CFG mode** — needs a read-only `/api/fn/{fn}/cfg` route over the existing
  `src/cfg` block graph, with `tests/ui-server/**` coverage. Follow-up.
- Whole-bundle map, clustering, force layout, WebGL (sigma.js) — held in
  reserve per spec 20 §2.4; nothing here needs them.
- Enabling `view.graph` in `src/ui-core/actions.ts` (see §4).
- Persisting graph state across sessions; export to SVG/PNG.
