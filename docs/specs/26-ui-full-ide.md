# 26 — Stage-3 full IDE: the build plan that replaces the MVP defaults (spec)

Status: **written 2026-09-05 (Claude Opus 5, lean worker)**, on Fred's
instruction to stop building to the MVP spec and build the real one. The
recommendations of specs 19, 20 and 21 are ratified by that instruction and
recorded as **D29**; this document is the plan that executes them.

> **Fred, 2026-09-05 07:20 (verbatim intent):** *"Why are you using the MVP
> spec? I meant the final one. The MVP was just because I didn't have lots of
> usage. Now I've got lots of usage — use the real one from now on."*

The "real one" is the full Stage-3 IDE of specs 19–21: **Option A** (a local
web app, one Node process, two transports over one warm service pair — spec 19
§3), the **spec 20 §3 stack**, and the **spec 21 §3 recommendation** (log as
the change feed, in-process bus as the doorbell; worktrees for speculative
source edits and version comparison only).

Reading list: `docs/specs/22-ui-mvp.md` (what shipped, and its §1 table of
defaults this spec retires), `docs/specs/19-ui-investigation.md` §0–§2 §5,
`docs/specs/20-ui-aesthetics-and-libraries.md` §1–§4,
`docs/specs/21-live-update-and-worktrees.md` §1–§3 §5, `docs/UI.md` (the
as-built shell), `docs/specs/23-ui-workers.md` §6 §10 and
`docs/specs/25-ui-graph-view.md` (the two surfaces this spec does **not**
re-plan).

**Not re-planned here** (in flight or shipped; this spec depends on them but
never re-specifies them):

- **(a) key bindings fix + settings dialog** (UI key-binding editor + theme
  settings) — agent running now.
- **(b) graph view** per `docs/specs/25-ui-graph-view.md` — agent running now.
- **(c) workers rail** per `docs/specs/23-ui-workers.md` §6/§10 — partly
  shipped (jobs rail, presence, suggestions, promote/reject).

## 1. Delta table — every MVP shortcut, and what the full IDE does instead

"Breaks?" answers three contracts only: **T** = `ui/theme.json` (a preset gains
or renames a token path), **K** = `ui/keymap.json` (a preset gains or renames a
binding), **H** = the HTTP contract in `docs/UI.md`'s route table / spec 22
§3.5 (a route, its shape, or its auth changes). "additive" means old configs
and old clients keep working.

### 1.1 The seven rows of spec 22 §1 (the MVP's own "Revisit" column)

| # | Decision | Full spec says | Exists now | What changes | Breaks? |
|---|---|---|---|---|---|
| 1 | Hosting / process | Option A: one Node process serving the SPA + a thin projection of `McpResources`/`McpTools`; MCP and UI are two transports over one warm service pair (spec 19 §3) | `src/ui-server/{server,routes,list,segregation,workers-routes}.ts`, pure `handle()`, localhost; the MCP binding is **not** co-hosted — a separate process holds its own service pair | Nothing structural. D29 ratifies Option A as built and ratifies **HTTP/JSON as the wire** (spec 19 §5.2 / Option D); the MCP-as-wire option stays swappable because `ui/src/api.ts` is already one table. Co-hosting MCP in the same process is **deferred**, not adopted: it buys a shared bus we get anyway from L1, and costs the `-wal` hand-off question (spec 16 §1.1) | no |
| 2 | Auth | localhost bind **plus random port + token hygiene** (spec 19 §3 "bind 127.0.0.1, random port + token") | binds `127.0.0.1`, fixed default port 7331, **no token**; CORS reflects any `localhost:*` origin | L2: a per-run token minted at startup, handed to the browser once in the launch URL, stored in `sessionStorage`, sent as `Authorization: Bearer`; `--no-auth` for the e2e rigs and for `PW_READONLY` runs | **H** (every request gains a header; `--no-auth` keeps old clients working) |
| 3 | Live-update wire | log **is** the change feed; in-process `wrote(seq, shardIds)` as a zero-latency doorbell; each view applies deltas by `seq` and refetches only the named targets (spec 21 §1.3, §3) | SSE `/api/events` exists, but `server.ts` **polls `tailLog` on a 500 ms `setInterval`**, and the client (`ui/src/hooks.ts` `useLog`) feeds the frames to the **Activity pane only** — no query is invalidated, so an agent's rename shows in the feed and *not* in the panes | L1: service emits `wrote(seq, targets)`; `/api/events` forwards on the event (poll retained as fallback); client gains a pure `applyLogDelta(entry) -> queryKeys[]` and invalidates exactly those | **H** additive (frame gains `targets`; `/api/log/tail` cursor contract unchanged) |
| 4 | Token format | spec 20 §1.2: a full token layer — spacing scale, **type ramp**, semantic colour, **severity ramp**, **syntax palette**, **elevation/radius/border** — with a gate lint that fails on raw hex, off-scale px, off-scale font size | `ui/theme.json` → `ui/themes/{dark,light}.json` → CSS vars → Tailwind `@theme inline`. Has palette, severity, fonts, radius, spacing, densities. **No type ramp, no elevation levels, no syntax palette** (CodeMirror highlighting is themed ad hoc in `cm-theme.ts`); the lint gate (`tests/gate/ui/tokens.test.ts`) catches colours only | L3: D29 **ratifies `theme.json` as the token source of truth** (a superset of spec 20 §4.4's "Tailwind config is the token layer" — it is runtime-switchable and already gate-linted); add the missing groups; extend the lint to off-scale spacing and font-size | **T** additive-but-required (presets must gain the new groups; the existing parity check makes a half-added group a gate failure) |
| 5 | Art-direction seed | spec 20 §1.5: the owner supplies one seed (theme, or a reference screenshot, or an edited token file); §1.4 adds `docs/ui-refs/` as the match target | placeholder palette (cool slate `#0e1520` / `#4c9be8`, IBM Plex); **`docs/ui-refs/` does not exist** | L3 lands `docs/ui-refs/` + the screenshot-match checklist; the seed values themselves are **Needs Fred** (§4.1). Structure does not change when the seed lands — only preset values | **T** values only (no path changes) |
| 6 | Layout engine (graph) | neighbourhood-scoped graph, React Flow + dagre (D28) | shipping now, landing (b) | nothing here; §2 plans only the **CFG mode** follow-up spec 25 §7 left open | **H** for the new `/api/fn/{fn}/cfg` route (additive) |
| 7 | Worktrees | spec 21 §2.1/§2.4: an ephemeral worktree (or scratch copy) per `recompile_edit` experiment, torn down after; **not** for annotations | `POST /api/tools/recompile-edit` is routed to `McpTools.recompileEdit` with **no sandbox and no UI**; nothing creates or removes a worktree | L8: `src/ui-server/sandbox.ts` creates/destroys the sandbox around the call, the warning + `{kind:"edited-and-recompiled"}` watermark are forwarded verbatim, and the UI flow is attended-only | **H** additive (response gains the sandbox id/teardown status) |

### 1.2 Other MVP shortcuts found in spec 22 §2 "Out", spec 23, `docs/UI.md` and the code

| # | Shortcut | Full spec says | Exists now | What changes | Breaks? |
|---|---|---|---|---|---|
| 8 | Component primitives | spec 20 §3: **shadcn/ui + Radix** | Radix primitives + a hand-rolled `ui/src/components/primitives.tsx`; no shadcn | D29 **ratifies the substitution** (shadcn's value was "components as source you own" — `primitives.tsx` already is that, and adopting shadcn now would rewrite every pane for no user-visible gain). Recorded so the stack table is honest, not silently diverged | no |
| 9 | Virtualised, sortable result lists | spec 20 §2.5: **TanStack Table** (sort/filter/paginate) + **TanStack Virtual** everywhere a list can be long | `@tanstack/react-virtual` windows the module tree only. Search hits are **silently `slice(0, 100)` / `slice(0, 200)`** in `LeftPane.tsx` — a cap with no truncation bar, which is exactly the idiom the rest of the project forbids | L5: TanStack Table over every result list (xrefs, search, findings, leads, strings, tables, log), virtualised rows, sort/filter, and the project's honest truncation bar wired to the contract's own caps | no |
| 10 | Tree navigator | spec 20 §2.5 names **react-arborist** | `@tanstack/react-virtual` + own tree state in `LeftPane.tsx` | D29 ratifies the substitution (spec 20 itself allows "TanStack Virtual + own tree state if finer control wanted"); L4 extends the same tree, it is not replaced | no |
| 11 | Screens navigator | spec 19 §0: the navigator is the flagship view; `docs/UI.md` "Screens first" already groups by `/api/segregation` | a **flat** group list (Screens / Navigation / App / one per package / Unclassified). No hierarchy inside Screens, and no edges: which screen reaches which is invisible | L4 ("listing-2"): a hierarchical screens tree with **navigation arrows** — screen→screen edges served by a new `GET /api/screens` over the existing segregation + points-to data, drawn in the tree and openable in the graph pane | **H** additive (new route) |
| 12 | One right panel at a time | spec 19 §1.5 / §0: multi-pane, cross-pane sync ("click xref row → source pane jumps") | `RightPanel` is a single-selection union of 8 tabs; only one can be visible; layout is not saveable beyond `autoSaveId` pane sizes | L10: nested `react-resizable-panels` groups so two right panels can be stacked, plus named saved layouts | no |
| 13 | Address-style navigation | spec 19 §1.5: "`fn`, module, sid as **URL state**, back/forward" | an in-memory jump list (`ui/src/state/selection.ts`, cap 100) with top-bar arrows; **the URL never changes**, so nothing is deep-linkable, reload loses the selection, and the browser's own back button leaves the app | L10: selection ↔ `?mod=&fn=&panel=` via `history.pushState`; the jump list becomes a view over it | no |
| 14 | Findings / leads workflow | spec 19 §0: evidence-gated write UI with the backend's rejection surfaced verbatim; `log`/`history/{target}` as the audit view | findings **list** + an add-finding form (spec 22 §3.6). No status transitions, no evidence-resolution display, no lead→finding promotion, no `history/{target}` view | L6: full status workflow through `POST /api/tools/set-finding-status`, evidence state shown, lead promotion, per-target history | no (routes exist) |
| 15 | Component/DOM test layer | spec 19 §2 layer 2 (Testing Library over jsdom or browser mode) | **absent** — the layers in use are 1 (`tests/ui-core`, `tests/gate/ui`), 3 (`ui/e2e`) and 5 (the fixture rig) | L7 adds layer 2 as a `ui/`-only devDependency (the root package stays zero-runtime-dep) | no |
| 16 | Visual regression | spec 19 §2 layer 4: one screenshot baseline per major view, regeneration under the golden rule | **absent**; one smoke spec + the graph spec | L7 adds baselines; **regeneration is a Fred-approved batch** (§4.2) | no |
| 17 | Reference-driven screenshot loop | spec 20 §1.4/§1.7: implement → screenshot → compare against `docs/ui-refs/` → fix tokens/structure | absent (no refs, no checklist) | L3 lands the refs + checklist; L7 makes it a repeatable step | no |
| 18 | Kitchen-sink route | spec 20 §1.7 step 2: every primitive rendered once on the dark theme before views exist | absent | L7: a `?kitchen-sink` route, screenshotted per theme preset — also the only remaining consumer of `ui/src/mock.ts` (§3.2) | no |
| 19 | Both themes checked | spec 22 §2 out: "only `dark` preset visually checked" | unchanged — `light.json` exists and is parity-checked for **token presence**, never rendered in a test | L7: baselines for both presets | no |
| 20 | Cold start | spec 19 §1.5: "performance floors on the golden fixture, no whole-bundle fetches" | `rawFrames` is ~58.5 s of a ~65 s first-request cost on Service NSW and **cannot** move to a worker thread (`ModuleAnalysis` is not structured-cloneable); prewarm hides it, a cold request does not | Out of scope for this spec — the real fix is a `rawFrames` `indices` option in `src/cfg`, which is a core-pipeline change with its own spec. **Recorded here so the UI plan does not pretend it is a UI problem** | no |
| 21 | fn 0 default selection | — | `App.tsx` does `useSelection().fn ?? 0`, so every fresh load fires `/api/fn/0/context` and logs a 400 (allowlisted in the smoke spec) | fixed by L10's URL-addressed selection: "nothing selected" stops collapsing into fn 0 | no |
| 22 | Worker rail scope | spec 23 §6 | jobs / presence / suggestions shipped (landing (c)) | not re-planned; L1's delta apply removes the workers rail's own 1 s poll where the event feed already carries the fact | no |

## 2. Landing sequence

**Ten landings.** Ordering rationale, in priority order:

1. **Contract-affecting first** (L1 live update, L2 auth): every later landing
   and every e2e rig is written against the post-change shape, so nothing is
   written twice.
2. **Then the layer everything visual reads from** (L3 tokens): the seed can
   land into it whenever Fred supplies it, and no view built after L3 needs
   restyling when it does.
3. **Then user-visible value** (L4 screens, L5 tables, L6 findings) — the
   three things "lots of usage" actually meets.
4. **Then the quality loop** (L7): DOM + visual layers, once the views they
   would baseline exist (baselining a view that is about to change is waste).
5. **Then the risky/heavy** (L8 worktrees, L9 CFG) — both grow the contract
   and both touch code outside `ui/`.
6. **Workspace polish last** (L10), because it is the one that benefits most
   from Fred having used the intermediate builds.

Model: **Sonnet** unless marked Opus. Every landing ships tests + the docs it
changes + an `docs/AGENT-LOG.md` line, per CLAUDE.md.

**Acceptance-test convention for this spec.** Each landing below names its test
files and the **exact test titles** that constitute acceptance. This spec ships
the list rather than the files: a `tests/gate/**` skeleton must bump
`docs/test-count-baseline.json`, which is a shared file four concurrent agents
are also touching, and a stale bump breaks the gate for all of them. The
implementer of each landing creates its named file, writes those titles, and
bumps the baseline once, re-derived from committed HEAD (the existing
convention in `docs/AGENT-LOG.md`). Titles marked **(todo)** are the ones the
implementer may land as `test(name, {todo:true})` if the surface is not yet
reachable; nothing else may be.

---

### L1 — Live update: in-process write bus + shard-addressed delta apply · Sonnet

**Why first:** it is the one MVP default that is *wrong* rather than merely
thin. Today an agent's rename reaches the Activity feed and nowhere else, which
is the exact failure spec 21 was written to prevent.

**Scope.** (i) `src/ui-server/server.ts`: after any write that lands, and after
the log gains rows, emit `wrote(seq, targets)` on a small in-process emitter;
`/api/events` forwards on the event instead of waiting for its 500 ms tick (the
tick stays as the fallback and as the only path for a *second* process, per
spec 21 §1.2). (ii) The SSE `log` frame gains `targets: string[]` (the `fn:N` /
`mod:N` the entries name) — additive, old clients ignore it. (iii)
`ui/src/state/log-delta.ts`: a **pure** `applyLogDelta(entry) -> readonly
string[]` mapping a log entry to the TanStack Query keys it invalidates; the
feed hook calls it, so an external write refreshes exactly the panes that
changed. (iv) `useLog` keeps a durable cursor; the `LOG_FEED_MAX_ROWS` window
may drop *display* rows but must never drop an *unapplied* delta.

**Files.** `src/ui-server/server.ts`, `src/ui-server/routes.ts` (frame shape
only), `ui/src/hooks.ts`, `ui/src/state/log-delta.ts` (new),
`ui/src/panes/BottomPane.tsx`.

**Tests.**
- `tests/ui-core/log-delta.test.ts` — `applyLogDelta: a set_name on fn:N invalidates that fn's keys and nothing else`; `applyLogDelta: an unknown target invalidates nothing rather than everything`; `applyLogDelta: a finding write invalidates the findings key`.
- `tests/ui-server/events-bus.test.ts` — `/api/events emits within 50 ms of a write, not on the poll tick`; `a missed doorbell still converges: replay from the cursor yields the same rows`; `the frame's targets match the log entries' targets`.
- `ui/e2e/live-update.spec.ts` — `an out-of-band write appears in the pane, not only in the activity feed` (drive a write through `McpTools` directly, assert the Context pane's name row updates without a manual refresh).

**Docs.** `docs/UI.md` (the live-update paragraph + route table frame shape),
this spec's §1.1 row 3.

**Depends on:** nothing.

---

### L2 — Loopback auth: per-run token, random port · Sonnet

**Scope.** Mint a token per server run; print it in the launch URL; the SPA
lifts it from `location` into `sessionStorage` and sends `Authorization:
Bearer`. Default port becomes 0 (kernel-assigned) with `--port` to pin;
`--no-auth` disables both for the e2e rigs. CORS narrows to the exact origin
the launcher printed.

**Files.** `src/ui-server/server.ts`, `src/cli` (the `ui-server` entry),
`ui/src/api.ts`, `ui/e2e/prepare-fixture.mjs` + `playwright.config.ts`
(`--no-auth`).

**Tests.**
- `tests/ui-server/auth.test.ts` — `a request without the token is 401`; `the token from the launch URL is accepted`; `--no-auth serves unauthenticated (the e2e rig's mode)`; `CORS reflects only the launched origin`.
- `ui/e2e/smoke.spec.ts` — unchanged behaviour under `--no-auth` (no new title; the existing spec must still pass).

**Docs.** `docs/UI.md` "Run it", spec 26 §1.1 row 2.

**Depends on:** nothing (do it before L4–L10 so no rig is written twice).

**Landed 2026-09-05** (Claude Sonnet 5, lean worker). `src/ui-server/server.ts`
mints a `randomBytes(24)` hex token per process (`UiServerOptions.noAuth`
skips it) and gates every `/api/*` request (including `/api/events`, checked
ahead of that route's own branch) on `Authorization: Bearer <token>` OR
`?token=<token>` — the query form exists because a browser's native
`EventSource` cannot set headers at all, and both the launch URL and
`ui/src/hooks.ts`'s SSE connection use it. `DEFAULT_PORT` is now `0`
(kernel-assigned); every existing caller already passed `port: 0` (tests) or
`--port` (the real rigs), so this only changes behaviour for a caller that
gives neither. `UiServerOptions.origin` (CLI `--origin <url>`), when given,
replaces the loopback-any CORS check with an exact match against that one
origin; the default (no `--origin`) keeps the prior loopback-any behaviour,
since the launcher does not in general know which port a separately-served
SPA (`vite dev`/`vite preview`) will bind — full "narrows to the exact
origin" enforcement needs the launcher and the SPA server to be one
coordinated process, which is out of this landing's scope (documented as a
partial completion, not a pushback: nothing existing was inverted). `src/
cli.ts`'s `ui-server` subcommand gained `--no-auth` and `--origin <url>` and
prints the token in the launch URL: `http://host:port/?token=...`.
`ui/src/api.ts`'s `bootstrapToken()` lifts `?token=` out of `location` into
`sessionStorage` on first load (module-level side effect, so importing
`api.ts` at all does it) and exposes `authHeaders()`/`authQueryParam()`,
consumed by every fetch call site in `ui/src/` (`actions/writes.ts`,
`listing/{use-screens,wire}.ts`, `workers/wire.ts`, `hooks.ts`'s
`EventSource`). `ui/e2e/playwright.config.ts`'s own `ui-server` command
gained `--no-auth` (a throwaway per-run project, no token ceremony needed);
`ui/e2e/prepare-fixture.mjs` needed no change (it never starts the server
itself). Six existing `startUiServer(...)` test call sites that make REAL
HTTP requests (two in `tests/ui-server/routes.test.ts`, one in `tests/
ui-server/events-bus.test.ts`) needed `noAuth: true` added since auth is now
on by default; the many more callers that only ever exercise the pure
`handle()` function were untouched (auth is server.ts's own gate, `handle()`
stays transport-agnostic). New `tests/ui-server/auth.test.ts` — not under
`tests/gate`, so `docs/test-count-baseline.json` needed no bump (0 `test(`
call sites added there).

---

### L3 — Token layer completion + `docs/ui-refs/` · Sonnet

**Scope.** Add to both presets: a **type ramp** (`text.xs/sm/base/lg` → CSS
vars, replacing per-view font sizes), **elevation** (2 levels, flat-and-bordered
per spec 20 §1.2), an explicit **border** token set, and a **syntax palette**
consumed by `ui/src/listing/cm-theme.ts` *and* by the disasm view, so both panes
share one set of names. Extend `tests/gate/ui/tokens.test.ts` from
colour-only to also fail on off-scale spacing (a raw `px` in a Tailwind
arbitrary value) and off-ramp font sizes. Land `docs/ui-refs/` with the
reference screenshots Fred names (§4.1) and `docs/ui-refs/README.md` carrying
spec 20 §1.4's four-question match checklist.

**Files.** `ui/themes/{dark,light}.json`, `ui/src/theme/{tokens,apply,theme.css}`,
`ui/src/listing/cm-theme.ts`, `tests/gate/ui/tokens.test.ts`, `docs/ui-refs/**`.

**Tests.** (extend `tests/gate/ui/tokens.test.ts`, same file)
- `token lint: fails on an off-scale font size`; `token lint: fails on a raw px in a Tailwind arbitrary value`; `token lint: the type ramp exists in both presets`; `token lint: the syntax palette is complete in both presets`; `token lint: the new detectors still fire on samples (no silent no-op)`.

**Docs.** `docs/UI.md` "Theme" table (new groups), `docs/ui-refs/README.md`.

**Depends on:** nothing structural. **Blocks:** L7's baselines (baseline after
the ramp exists, not before). The seed *values* (§4.1) may land later without
re-doing this landing.

---

### L4 — listing-2: hierarchical screens tree + navigation arrows · **Opus**

**Interpretation note for the orchestrator.** "Screens tree + arrows" is read
here as: the Screens group becomes a *hierarchy* (screen → the components and
sub-screens it owns) and gains **navigation edges** (which screen navigates to
which). The flat Screens/Navigation grouping and the top-bar back/forward
arrows already exist (`docs/UI.md` "Screens first", `ui/src/state/selection.ts`)
and are not what this landing is about. If Fred meant something narrower, this
is the cheapest landing to re-scope.

**Scope.** The contract grows first (spec 19 §1.4's rule): `GET /api/screens`
returns `{screens: [{mod, fn, label, kind, children: mod[], navigatesTo:
[{mod, via, confidence}]}], total}`, derived server-side from
`src/split/segregate.ts`'s navigator detection plus the points-to resolved call
edges (`index/calls-resolved.jsonl`) — **never** from a name heuristic in the
UI. Unresolved/by-name edges are returned with `confidence:"by-name"` and must
render dashed, exactly as spec 25 §3 requires of the graph.

**Files.** `src/ui-server/screens.ts` (new) + `routes.ts` row,
`ui/src/listing/screens.ts` (new, pure tree/edge model),
`ui/src/panes/LeftPane.tsx`, `ui/src/graph/model.ts` (a `screens` mode reusing
the existing renderer), `ui/src/contracts.ts`.

**Tests.**
- `tests/ui-server/screens.test.ts` — `every screen row names a module that exists in the segregation result`; `a navigation edge is only "resolved" when the points-to index proved it`; `by-name candidates are returned with confidence "by-name"`; `404 when the project has no split module tree`.
- `tests/gate/ui/screens-model.test.ts` — `screensTree: children never duplicate a parent (no cycles in the tree projection)`; `screensTree: an edge to an unknown module is dropped, not rendered as a stub`.
- `ui/e2e/screens.spec.ts` — `the Screens group renders a hierarchy, not a flat list`; `a navigation arrow opens the target screen in the centre pane`; `by-name edges are dashed` (todo until the fixture has one).

**Docs.** `docs/UI.md` ("Screens first" → the hierarchy + edges), route table.

**Depends on:** L1 (so a rename from anywhere refreshes the tree).

**Landed 2026-09-05** (Claude Opus 5, lean worker). `src/ui-server/screens.ts`
holds both the computation and the route table row; per the shared-tree rule
it does not edit `routes.ts` itself, so L1's owner adds exactly one line
there: `const ROUTES: readonly Route[] = [...BASE_ROUTES, ...WORKER_ROUTES,
...SCREENS_ROUTES];` plus the matching import. Until that line lands the route
404s and the left pane stays on the flat grouping (the deliberate fallback).
Client side: `ui/src/listing/screens.ts` (pure model), `use-screens.ts`
(query + fetch), `ui/src/listing/modules.ts` (`flattenTree` gained an
optional `extras` hook and a `nav` row kind), `ui/src/panes/LeftPane.tsx`,
`ui/src/graph/model.ts` (`buildScreensModel`), `ui/src/contracts.ts`.

---

### L5 — Virtualised, sortable result tables everywhere · Sonnet

**Scope.** Introduce `@tanstack/react-table` (MIT, spec 20 §2.5) and one
shared `<ResultTable>` composed from it + `@tanstack/react-virtual` + the
token primitives. Convert xrefs, search hits, findings, leads, strings, object
tables, jobs and the log to it. **Delete the silent `slice(0, 100)` /
`slice(0, 200)` caps** in `LeftPane.tsx` and replace them with the project's
honest truncation bar reading the contract's own cap (`RESOURCE_CAPS`), which
is the same idiom `CenterPane.tsx` and spec 25 §5 already use.

**Files.** `ui/package.json`, `ui/src/components/ResultTable.tsx` (new),
`ui/src/panes/{LeftPane,RightPane,StringsPane,TablesPane,WorkersPane}.tsx`,
`ui/src/activity/LogTab.tsx`.

**Tests.**
- `tests/gate/ui/result-table.test.ts` — `no pane slices a result list without rendering a truncation bar` (a source scan, in the style of `tests/gate/passes/imports.test.ts`); `every long-list pane imports ResultTable`.
- `ui/e2e/tables.spec.ts` (extend) — `sorting a column reorders rows without refetching`; `a capped result renders the truncation bar with the cap's own number`; `10k rows scroll without mounting 10k DOM nodes`.

**Docs.** `docs/UI.md` (a "Result tables" section; delete the cap claims).

**Depends on:** L3 (tokens the table reads).

**Landed 2026-09-05** (Claude Sonnet 5, lean worker). `ui/src/components/ResultTable.tsx`
(new) — `@tanstack/react-table@8.21.3` pinned exact (the well-known, stable
v8 API: `useReactTable`/`getCoreRowModel`/`getSortedRowModel`/`flexRender`;
v9, npm's current `latest` tag, ships a rewritten hook-store API with no
`useReactTable` at all — too large a surface change to adopt sight-unseen in
this landing) + the existing `@tanstack/react-virtual`. `LeftPane.tsx`'s
`slice(0, 100)`/`slice(0, 200)` search-hit caps are gone: module hits render
uncapped (a client-side filter, `ResultTable` just virtualises the full
match set) and function hits carry the server's own `truncated`/`total`
(`search/functions`'s `SEARCH_PAGE_CAP`) in the bar. Converted: `LeftPane.tsx`
(search hits, Leads tab), `RightPane.tsx` (Xrefs' called-by/calls lists,
Findings), `StringsPane.tsx` (string-grep hits, globals uses — each row's
own uses list moved to a master/detail panel below the table rather than
growing the row in place, so rows stay one fixed height and virtualise),
`TablesPane.tsx` (object-table inventory, same master/detail split for a
table's members), `WorkersPane.tsx` (jobs rail), `LogTab.tsx` (activity log,
now sortable). Left alone: Xrefs' by-name heuristic candidates list (not in
the file's named scope, and already has an e2e selector on its exact
`<button data-fn>` markup). Tests: `tests/gate/ui/result-table.test.ts` (4
tests, source-scan style), `ui/e2e/tables.spec.ts` extended with the 3 named
acceptance tests (the 10k-row test intercepts `GET /api/object-tables` with
a synthetic page — no real fixture bundle carries that many constant
tables). `docs/test-count-baseline.json` bumped 1264 -> 1268. Needs Fred:
row height / header styling used the existing `--row-height` token and
`text-xs`/`text-text-muted` defaults already in use elsewhere (no new art
direction invented); the findings/leads tables collapse each record to one
line (claim/detail truncated) pending L6's fuller evidence UI.

---

### L6 — Findings and leads: the full evidence-gated workflow · Sonnet

**Scope.** Status transitions (`open → confirmed / dismissed / …`) through
`POST /api/tools/set-finding-status`, with the backend's rejection message
surfaced **verbatim** (spec 19 §1.4). Evidence state per finding (resolved /
unresolved, with the ref). Lead → finding promotion from the Leads tab
(prefilled from the lead, one action `finding.fromLead`). A per-target history
view over `GET /api/history/{target}`, reachable from the context menu.
Severity rendered from the L3 severity ramp only.

**Files.** `ui/src/panes/RightPane.tsx`, `ui/src/components/FindingForm.tsx`,
`ui/src/panes/HistoryPane.tsx` (new), `ui/src/actions/registry.ts`,
`ui/src/actions/writes.ts`.

**Tests.**
- `tests/ui-core/finding-action.test.ts` (extend) — `finding.fromLead is enabled only on a lead target`; `finding.setStatus is disabled on a finding whose evidence has not resolved`.
- `ui/e2e/findings.spec.ts` — `a bad evidence ref shows the backend's own rejection text`; `a confirmed finding shows its evidence ref`; `promoting a lead prefills the finding form from the lead`; `the history view lists the target's revisions oldest-first`.

**Docs.** `docs/UI.md` (Findings/Leads sections).

**Depends on:** L1 (status changes made by an agent must appear live), L5
(the list it renders in).

**Landed 2026-09-05** (Claude Sonnet 5, lean worker). All four backend
routes (`set-finding-status`, `record-finding`, `history/{target}`,
`leads`/`security-sinks`) already existed and are untouched beyond the
`/api/leads` off-main-thread move below — this landing is almost entirely
frontend. `src/ui-core/actions.ts` gained `finding.fromLead` (enabled only
on a `"lead"` selection), `finding.setStatus` (enabled only once
`Selection.evidenceResolved` is true) and `view.history` (any function/
module selection); `ui/src/panes/RightPane.tsx`'s Findings tab renders each
finding's evidence refs individually (resolved vs. not) and an inline
status control whose rejection is the backend's `set_finding_status` message
verbatim; `ui/src/panes/LeftPane.tsx`'s Leads rows got a "+finding" button;
`ui/src/panes/HistoryPane.tsx` (new) renders `GET /api/history/{target}`
oldest-first. `ui/src/components/FindingForm.tsx` grew an optional `lead`
prop so `finding.fromLead` opens the same dialog `annotate.finding` does,
pre-filled from the lead rather than blank; a lead with no owning function
(`SinkLead.fn === null`) stays refused client-side (no location to attach
the finding to) rather than fabricating one.

**Needs Fred / follow-up**: exercising the status control end to end against
a real `hbc2js init` (DB-backed) project surfaced a pre-existing backend bug,
new docs/BUGS.md row (2026-09-05, "spec 26 L6 ... discovered exercising
POST /api/tools/set-finding-status"): a DB-backed project's confirmed/
refuted transition persists (the write returns 200, evidence merges
correctly) but never surfaces on any later read (`GET /api/findings`, MCP
`finding`/`findings`, the CLI) — `src/project/findings.ts`'s `FindingStore`
still expects live status from a separate `kind:"status"` revision that the
DB-backed write path never produces. Out of this landing's `ui/`+`src/
ui-server` scope (`src/project/service.ts`/`findings.ts` fix needed);
`ui/e2e/findings.spec.ts`'s "a confirmed finding shows its evidence ref"
test reads the live status from the API rather than hard-coding "confirmed"
so it pins today's real behaviour honestly either way.

Also closes docs/BUGS.md's 2026-09-05 UI-BURS-bur-1-row-2 row: this landing
makes the Leads tab load-bearing (lead promotion), so `computeLeads`
(previously cached-but-still-inline, still capable of head-of-line-blocking
every other route on its first call per artifact) now runs on a
`node:worker_threads` worker (`src/workers/leads-worker.ts`, `src/ui-server/
list.ts`'s `listLeads`), the exact pattern `src/ui-server/segregation.ts`
already used for `segregateSplitTree`. `LeadsResult.computing` mirrors
`SegregationResult.computing`; `ui/src/hooks.ts`'s `useLeads` polls at
500 ms while it is true. Regression tests: `tests/ui-server/routes.test.ts`
("listLeads never blocks…", "a concurrent request answers fast while
/api/leads is in flight…").

---

### L7 — The missing test layers: DOM tests + visual baselines + kitchen sink · Sonnet

**Scope.** Spec 19 §2 layers 2 and 4. Add Testing Library + a browser-mode or
jsdom runner as `ui/`-only devDependencies (the root package's
zero-runtime-dependency rule is untouched). Add a `?kitchen-sink` route
rendering every primitive once per preset (spec 20 §1.7 step 2). Add Playwright
screenshot baselines for the major views (listing, xrefs, findings, graph,
screens, kitchen sink) × (dark, light). Write `docs/ui-refs/CHECKLIST.md`'s
loop into `docs/UI.md` so the next agent follows it mechanically.

**Golden rule.** Baselines are golden artifacts: the **first** commit of them
and every regeneration are a Fred-approved batch (§4.2, CLAUDE.md testing
rules). They are UI-private fixtures, so the "no exact-output assertions on
shared fixtures" rule is not violated — record that explicitly in
`docs/CONSOLIDATION.md`, which spec 19 §2 layer 4 already asked for.

**Files.** `ui/package.json`, `ui/src/components/KitchenSink.tsx` (new),
`ui/e2e/visual.spec.ts` (new), `ui/e2e/__screenshots__/**`,
`docs/CONSOLIDATION.md`, `docs/UI.md`.

**Tests.**
- `ui/e2e/visual.spec.ts` — `kitchen sink matches the baseline (dark)`; `kitchen sink matches the baseline (light)`; `listing matches the baseline`; `right pane: xrefs matches the baseline`; `graph pane matches the baseline`.
- `tests/gate/docs/testing-rules.test.ts` (extend) — `visual baselines live under ui/e2e and are declared UI-private in docs/CONSOLIDATION.md`.

**Depends on:** L3, L4, L5, L6 (baseline a view once it has stopped moving).
**Needs Fred:** §4.2.

**Landed 2026-09-05** (Sonnet, lean worker). Layer 2:
`@testing-library/react`/`@testing-library/dom` + `jsdom` + `vitest` as
`ui/`-only devDependencies (`ui/vitest.config.ts`, `npm run test:dom` inside
`ui/`; not part of the root gate). Layer 4: `ui/e2e/visual.spec.ts`, five
tests named exactly as this section lists. Every one of the five asserts DOM
structure unconditionally (never flakes on macOS-vs-Linux font rendering);
the pixel `toHaveScreenshot` comparison inside each test is gated behind
`HBC2JS_E2E_VISUAL=1` (`maxDiffPixelRatio: 0.03`,
`ui/e2e/playwright.config.ts`), so CI's default run never fails on
antialiasing noise. `ui/src/components/KitchenSink.tsx` (new), reached at
`index.html?kitchen-sink` (`ui/src/main.tsx` swaps it in for `<App/>` — a
query flag, not a router dependency), self-contained with its own
`Tooltip.Provider` and the only consumer of `ui/src/mock.ts`'s `mockApi`
outside `./api.ts`. Five baselines committed under
`ui/e2e/__screenshots__/visual.spec.ts/` (496 KB total): kitchen sink ×
(dark, light) — the two default preset slots, bur 12 — plus listing, xrefs
and graph on the dark default only, per this section's "keep them small"
instruction. **Needs Fred §4.2 updated below: this specific 5-baseline set
is the batch awaiting approval.**

---

### L8 — Worktree-backed speculative edits (`recompile_edit`) · **Opus**

**Scope.** spec 21 §2.1 + §2.4. `src/ui-server/sandbox.ts`: per-experiment
sandbox creation (`git worktree add` when the experiment needs the tree and
git's own diff; a plain temp copy for a single-file patch, which spec 21 §2.4
explicitly allows), guaranteed teardown on success, failure and process exit.
`POST /api/tools/recompile-edit` runs inside it and returns the sandbox id and
teardown status alongside `McpTools.recompileEdit`'s own result. UI: an
"Edit & recompile" flow that shows spec 17 §13's warning and the
`{kind:"edited-and-recompiled"}` watermark **verbatim, unmodified**, is
attended-only, and is never reachable from a worker (spec 23 §7).

**Files.** `src/ui-server/sandbox.ts` (new), `src/ui-server/routes.ts`,
`ui/src/panes/EditPane.tsx` (new), `ui/src/actions/registry.ts`.

**Tests.**
- `tests/ui-server/sandbox.test.ts` — `a sandbox is torn down on success`; `a sandbox is torn down when the recompile throws`; `the original bundle and .hbcproj are byte-identical after an experiment`; `two concurrent experiments never share a sandbox path`; `a worker-initiated recompile-edit is refused` .
- `ui/e2e/recompile.spec.ts` — `the warning and watermark text are shown verbatim`; `cancel writes nothing` (todo until the fixture has a recompilable function).

**Docs.** `docs/UI.md` (new section), spec 21 §2.1 status line.
**Depends on:** L2 (nothing that produces a binary ships before auth does).
**Needs Fred:** §4.3.

**Landed 2026-09-05** (Claude Opus 5, lean worker). `src/ui-server/sandbox.ts`
owns both the sandbox primitives (`createSandbox`/`destroySandbox`/
`withSandbox`/`liveSandboxPaths`, kinds `copy` (default) and `worktree`,
teardown guaranteed on success, on throw and on process exit) and the
`POST /api/tools/recompile-edit` handler, exported as `RECOMPILE_ROUTES` and
spliced into `routes.ts`'s single table by one line (the old inline handler
there is gone; the route's shape is unchanged apart from the additive
`sandbox: {id, kind, tornDown, teardownError?}` field). The worker refusal is
a 403 from `refusalForProvenance` before any sandbox is created. UI:
`ui/src/panes/EditPane.tsx` in a new right-pane "Edit" tab, one registry
entry `edit.recompile` with **no** default chord, a two-step confirm, and the
warning/watermark rendered verbatim. Default sandbox kind is `copy`
(**D31**), which §4.3 leaves Fred free to change to `worktree` in one word.

---

### L9 — Graph CFG mode + `GET /api/fn/{fn}/cfg` · **Opus** — LANDED 2026-09-05

**Landed.** `GET /api/fn/{fn}/cfg` lives in **`src/ui-server/cfg.ts`**, not in
`src/mcp/resources.ts` — the landing's call, and the reason is at the top of
that file: the MCP surface is the AGENT-facing contract (spec 17 §14
deliberately narrowed it), while a block graph is a rendering aid for one
pane, so growing `McpResources` would widen the agent contract, its docs and
its tests for a UI-only need. `screens.ts` (L4) set the precedent: a route
file of its own, registered with ONE line in `routes.ts`
(`...CFG_ROUTES`), reading the same shared `McpResources`/`ArtifactService`
pair. If an agent workflow ever needs the CFG, `McpResources.cfg()` is a
one-line delegation to `cfgOf`.

The blocks come from `src/cfg` through a new
`ArtifactService.functionCfg(fn)` (a live verb like `disasm`: `null` without
`--hbc`, so the route can DECLINE honestly rather than invent a graph). The
per-block source-line span is the SAME `lineMap` the listing aligns with, so
a block and the listing cannot disagree about which lines it covers. The UI
side is `buildCfgModel` in `ui/src/graph/model.ts` turning the rows into the
ordinary `GraphModel`, plus `modelForLevel(model, level, cfgModel)`: the
`near` semantic-zoom level (spec 25 §5b) draws mode 3 when the route answers
and degrades to `lodCard` when it declines. Everything else in spec 25 §5a/
§5b/§5c — drag, reset, follow, hysteresis, the frame-aware layout — is
unchanged and its e2e tests still pass. See spec 25 §3/§5b/§7 and
`docs/UI.md` "Graph view".

**Scope.** spec 25 §7's named follow-up: a read-only CFG resource over the
existing `src/cfg` block graph (blocks, edges, exception regions, the
instruction range per block), and spec 25 §3 mode 3 drawn with the shipped
React Flow + dagre renderer. Contract grows first; the UI adds no CFG logic.

**Files.** `src/mcp/resources.ts` (or `src/ui-server/cfg.ts` if the MCP surface
should not grow — decide in the landing and say why), `src/ui-server/routes.ts`,
`ui/src/graph/{model,layout,nodes}.ts`, `ui/src/contracts.ts`.

**Tests.**
- `tests/ui-server/cfg.test.ts` — `every edge names a block the response also contains`; `the block ranges partition the function's instructions with no gap or overlap`; `exception regions are reported, not silently dropped`; `capped at the published cap with an honest truncation field`. Shipped, plus four more the landing added: `a dangling edge is dropped with its block, never left pointing at nothing`; `a block's line span comes from the same linemap the listing aligns with`; `a bad or unknown fn is a 400/404, never a 500`; `a project with no --hbc declines the route rather than inventing a graph`.
- `tests/ui-core/graph-cfg-model.test.ts` (new, pure, no browser) — the seven `buildCfgModel`/`modelForLevel` rules, including `a block node is never a function node (ids and kinds do not collide)` and `modelForLevel: near draws the CFG when there is one, and the fetched neighbourhood when there is not`.
- `ui/e2e/graph.spec.ts` (extend) — `CFG mode draws the selected function's blocks`; `a block click scrolls the disasm pane to its first instruction`; plus `CFG mode: a branching graph draws every block and labels its true/false edges` (stubbed, because the rn-template fixture's own visible functions are single-block — the same stub discipline spec 25 §6 uses for expansion and the cap), and spec 25 §5b's near-level test re-pointed at the decline path (`the near level falls back to the focus card when the CFG route declines`), which keeps its honesty assertion.

**Docs.** `docs/specs/25-ui-graph-view.md` §3/§5b/§7 (mode 3 shipped), `docs/UI.md`.
**Depends on:** landing (b).
**Needs Fred (art direction, defaults picked here):** the block card's chips
(`entry`/`exit`/`catch`, terminator, `Ni`, `L<a>-<b>`) and the edge language —
`T`/`F`/`case n`/`default`/`exc` LABELS with dash patterns (`5 3` not-taken,
`2 4` exception, `4 3` by-name unchanged) and no colour encoding of a branch
outcome, so the graph stays readable in every theme and to a colour-blind
reader. `CFG_BLOCK_CAP = 300` mirrors `GRAPH_NODE_CAP`; a CFG-specific number
was not measured against real bundles.

---

### L10 — Workspace: URL addressing, multi-panel docking, saved layouts · Sonnet

**Scope.** (i) Selection ↔ URL (`?mod=&fn=&panel=`) via `history.pushState`;
the jump list becomes a view over browser history; **the `fn ?? 0` default dies
with it** (§1.2 row 21), and the smoke spec's console-error allowlist loses its
one entry. (ii) Nested `react-resizable-panels` groups so two right panels can
be shown at once. (iii) Named saved layouts (persisted like theme/density) and a
"reset layout" action. (iv) First-run default layout — Fred's call (§4.4);
implement whatever he names, with the current single-panel layout as the
fallback default.

**Files.** `ui/src/state/selection.ts`, `ui/src/App.tsx`,
`ui/src/panes/RightPane.tsx`, `ui/src/actions/store.ts`,
`ui/e2e/smoke.spec.ts` (allowlist removal).

**Tests.**
- `tests/ui-core/url-state.test.ts` — `selection round-trips through the URL`; `an unknown query param is ignored, not fatal`; `"nothing selected" is representable (it is not fn 0)`.
- `ui/e2e/workspace.spec.ts` — `a deep link opens the named function`; `reload restores the selection`; `two right panels can be shown at once`; `reset layout restores the default`; `no console errors on first paint` (the allowlist is empty).

**Docs.** `docs/UI.md` (Layout + a new "Addressing" section).
**Depends on:** L5, L6 (the panels being docked should be the final ones).
**Needs Fred:** §4.4 (first-run hierarchy only; everything else is mechanical).

## 3. What does NOT change — and where "nothing is throwaway" is false

Spec 22 §0 claimed *"Nothing built here is throwaway: the server, action
registry, theme and keymap are the ones the full IDE needs."* Checked against
the code, the claim is **mostly true and precisely four-fifths true**.

### 3.1 True — kept unchanged by the full IDE

- **`src/ui-server/routes.ts`'s pure `handle()` seam** (`{method,path,query,body}
  → {status,json}`, no `node:http` inside). Every landing above adds rows to
  the same table; nothing needs a second dispatcher. This is the single best
  decision the MVP made.
- **The route table itself.** Every row in spec 22 §3.5 survives; L1/L2/L4/L8/L9
  only add rows or additive fields. No route is deleted or reshaped.
- **The `/api/log/tail` cursor contract** (`seq > since`, oldest-first, cap 500,
  `cursor` = highest returned or `since` unchanged). Spec 23 §10 already reused
  it verbatim for `/api/worker-events`; L1 keeps it as the catch-up path.
- **`src/ui-core/` — the action registry, keymap resolution and the three JSON
  presets** (`default`, `vim`, `ghidra`), shared with the UI via `@ui-core`.
  Every new action in L4/L6/L8 is one registry entry and appears in the menu,
  the palette and the keymap for free, exactly as spec 22 §3.1 promised.
- **The theme pipeline shape** — `theme.json` → preset JSON → `:root` CSS vars
  → Tailwind `@theme inline`. L3 adds token *groups*; the mechanism, the
  parity check and the lint gate are unchanged. This is a **superset** of spec
  20 §4.4's "Tailwind config is the token layer", and the better answer,
  because it is runtime-switchable and machine-checkable.
- **The listing** — CodeMirror 6, whole-module file view, `linemap`-driven
  source↔disasm alignment, the pure `ui/src/listing/line-map.ts` helpers the
  root gate imports with no `ui/node_modules` present.
- **Segregation** — the worker-thread compute, the `project.hbcproj`-persisted
  cache (MIGRATION 4) and its "operational, never exported" classification.
  L4 builds *on top of* it.
- **`ui/src/contracts.ts`** as structural copies with "`src/mcp/` wins" as the
  tie-break rule.
- **The e2e fixture rig** — throwaway project + throwaway dist, env-overridable
  ports (`HBC2JS_E2E_PORT_BASE`, `HBC2JS_E2E_ROOT`), never the live rig. Every
  new spec above hangs off it unchanged.
- **The workers surface** (spec 23 §10) — jobs, presence, suggestions,
  promote/reject, and the `[ai-suggested]` / `tier:"suggested"` provenance
  rules. Untouched.

### 3.2 False — the four places the MVP did build something the full IDE replaces

1. **`ui/src/mock.ts` is throwaway, and is now carried cost.** It existed
   because landing 1 preceded the server; with the server shipped it is a
   second, divergent implementation of the route table that every new route
   must be added to or deliberately excluded from. The full IDE keeps it in
   exactly one role — the data source for L7's kitchen-sink route — and
   `VITE_API_MOCK` should stop being the *default* (`1` today), because the
   default entry point of a shipped tool should not be fake data.
2. **The `slice(0, 100)` / `slice(0, 200)` caps in `LeftPane.tsx` are
   throwaway and are a silent-truncation bug**, not merely a thin feature:
   they drop rows with no bar, in a project whose own idiom (`CenterPane.tsx`,
   spec 25 §5) is "never a silent trim". L5 deletes them.
3. **`/api/events` as a 500 ms `setInterval` poll of `tailLog` is throwaway
   plumbing.** The *endpoint* survives; its implementation is replaced by the
   in-process doorbell spec 21 §1.3 specified. More seriously, the **client
   half is architecturally throwaway**: `useLog` feeds the Activity pane and
   invalidates nothing, so the MVP shipped a live-update wire that does not
   make the UI live. That is the one place where "the MVP's plumbing is the
   full IDE's plumbing" is simply not true today.
4. **`App.tsx`'s `useSelection().fn ?? 0` and the in-memory-only jump list are
   throwaway.** The known 400-on-every-load console error (`docs/UI.md`
   "Known, reported, not fixed here") is a symptom of representing "nothing
   selected" as fn 0; L10's URL-addressed selection replaces the state model,
   not just the default.

Two further divergences are **not** throwaway but are recorded so the stack
table stops lying: **shadcn/ui was never adopted** (Radix + a hand-rolled
`primitives.tsx`), and **react-arborist was never adopted** (TanStack Virtual +
own tree state). D29 ratifies both substitutions rather than re-writing shipped,
working panes to match a library list.

## 4. Needs Fred

Four items. Everything else specs 19–21 reserved is decided by D29.

| # | Item | Why it cannot be an agent's call | Cheapest form of the answer |
|---|---|---|---|
| 4.1 | **The art-direction seed** (spec 20 §1.5) — and, with it, which reference screenshots go in `docs/ui-refs/` and how strict "match the reference" is (§1.4/§4.5) | An agent can propagate and match taste; it cannot originate it. This is the one input the whole §1 aesthetics playbook rests on | Either edit `ui/themes/dark.json`'s ~20 values, **or** name a theme ("Darcula-like"), **or** drop 2–3 screenshots into `docs/ui-refs/`. Any one of the three unblocks L3 |
| 4.2 | **Visual-baseline approval** (spec 19 §5.4 + CLAUDE.md golden rule) — **now concrete**: L7 landed 5 PNGs under `ui/e2e/__screenshots__/visual.spec.ts/` (kitchen sink × dark/light, plus listing/xrefs/graph on dark only), 496 KB total, generated with fonts/animations fixed and a 1280×800 viewport | Baselines are golden artifacts; the rule already says regeneration is Fred-approved and reviewed as a batch. The *first* commit of them is the same decision | "Yes, keep these 5" / "drop N, they'll re-baseline once view X settles" / "the pixel diff threshold (0.03) is too loose/tight" |
| 4.3 | **Whether `recompile_edit` may be driven from the UI at all**, and worktree vs scratch-copy for its sandbox (spec 17 §13 fenced this to the owner; spec 21 §5.2) | It is the one operation that produces a modified binary. Its sandboxing policy was explicitly reserved, twice | "UI may run it, attended, in a git worktree" / "…in a temp copy" / "not from the UI at all" |
| 4.4 | **First-run information hierarchy** (spec 20 §1.6) — which panes are open on opening a project, and what is one click vs three | Product judgment, not styling; tokens do not touch it and no test can decide it | One sentence, or a screenshot of the layout you want as the default |
| 4.5 | **How a navigation arrow should look in the tree** (spec 26 L4, landed) — arrows currently render as an indented `-> TargetScreen` row under an open screen, with `resolved` / `by-name` (italic, dashed marker) as the provenance label | Structure and provenance are decided by the data; whether an arrow is a row, a badge on the screen row, or only a graph-pane affordance is art direction | "rows are fine" / "make it a badge" / a screenshot |

Explicitly **not** on this list, because D29 decides them: framework/component
stack (ratified as built, §3.2's two substitutions included), the wire
(HTTP/JSON, MCP-as-wire stays swappable), token format (`theme.json`), lint
strictness (hard gate failure — it already is), elkjs vs dagre (D28), and
read-only-first (moot: writes shipped and are logged, evidence-gated and
hash-locked).

## 5. Successor / out of scope

- `rawFrames` `indices` (the cold-start cost, §1.2 row 20) — a `src/cfg` change
  with its own spec, not a UI landing.
- Whole-bundle map, clustering, WebGL — held in reserve (D28, spec 25 §7).
- MCP co-hosted in the UI server process (§1.1 row 1) — deferred, reopenable if
  a second writer ever needs it.
- A desktop shell around the web app (spec 19 §3 Option B/D) — still cheap to
  add later, still not needed.
