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

Tests 2–4 drive **stubbed** xref responses (`page.route`): the rn-template
fixture has no resolved `fn -> fn` call edges at all (its callees are
`require` module refs and `computed-callee` unknowns; its callers are all
`unknownInScope`), so expansion, re-focus and the cap cannot be exercised
against it honestly. The routes are the contract; the pane is what is under
test. Tests 1, 5 and 6 run against the real fixture server.

Plus `npm run typecheck` in `ui/` (React Flow and dagre are typed; no `any`).

## 7. Out of scope / follow-ups

- **CFG mode** — needs a read-only `/api/fn/{fn}/cfg` route over the existing
  `src/cfg` block graph, with `tests/ui-server/**` coverage. Follow-up.
- Whole-bundle map, clustering, force layout, WebGL (sigma.js) — held in
  reserve per spec 20 §2.4; nothing here needs them.
- Enabling `view.graph` in `src/ui-core/actions.ts` (see §4).
- Persisting graph state across sessions; export to SVG/PNG.
