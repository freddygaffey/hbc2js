# UI — the Stage-3 shell (spec 22 landing 1)

The `ui/` directory is a **separate npm package** (`hbc2js-ui`) holding the
local web app of spec 19 §3 Option A: Vite + React 19 + TypeScript +
Tailwind v4 + shadcn-style Radix primitives. The root package stays
**zero-runtime-dependency** — nothing in `ui/package.json` is ever added to
the root `package.json`, and the root `tsconfig.json` does not compile `ui/`
(it includes `src`/`tests`/`tools` only; `ui/` has its own tsconfig).

## Run it

```sh
cd ui
npm install
npm run dev        # http://127.0.0.1:5173
```

Other scripts: `npm run typecheck` (tsc --noEmit), `npm run build` (to
`ui/dist`, gitignored), `npm run preview`.

`ui/node_modules` and `ui/dist` are covered by the root `.gitignore`'s
`node_modules/` and `dist/` patterns; `ui/package-lock.json` is committed and
every dependency is pinned to an exact version (all MIT; TypeScript is
Apache-2.0, dev-only, same as the root).

## Data: contracts, API client, mock adapter

- `ui/src/contracts.ts` — TypeScript interfaces mirroring the return types of
  `McpResources` (`src/mcp/resources.ts`), `src/mcp/leads.ts`,
  `src/artifact/service.ts` and `src/project/schema.ts`. They are
  **structural copies, not imports**: `ui/` is a separate package and must
  not reach into the root `src/` tree. If a shape and its source disagree,
  `src/mcp/` wins — fix `contracts.ts`. Interfaces: `Bounded<T>`,
  `FnSummary`, `SourceText`, `NeighborRef`, `XrefEdge`, `StringUse`,
  `FnContext`, `WhoCalls`, `CallsFrom`, `ModuleInfo`, `SinkClass`,
  `SinkLead`, `LeadGroup`, `LeadsResult`, `SearchPage<T>`, `FunctionMatch`,
  `SourceMatch`, `Severity`, `FindingStatus`, `Tag`, `Provenance`,
  `EvidenceRef`, `FindingRecord`, `ResolvedFinding`, `LogEntry`, `LogPage`,
  `LogTail`, `PackageIdResult`.
- `ui/src/api.ts` — a `fetch` client over `VITE_API_BASE` (default
  `http://127.0.0.1:7331`). The route table it implements, which
  `src/ui-server` must serve, is:

  | Method | Route | Returns |
  |---|---|---|
  | GET | `/api/fn/{fn}` | `FnSummary` |
  | GET | `/api/fn/{fn}/source` | `SourceText` |
  | GET | `/api/fn/{fn}/disasm` | `SourceText` |
  | GET | `/api/fn/{fn}/locals` | `{rows:[{reg,rendered,named,role,uses}],total}` |
  | GET | `/api/fn/{fn}/context` | `FnContext` |
  | GET | `/api/fn/{fn}/callers` | `WhoCalls` |
  | GET | `/api/fn/{fn}/callees` | `CallsFrom` |
  | GET | `/api/module/{id}` | `ModuleInfo` |
  | GET | `/api/module/{id}/source` | `ModuleSource` — whole file text + every owned fn `{fn,name,lines}`; the FILE view (select a module, see all its functions; per-function focus is optional, not forced) |
  | GET | `/api/segregation` | `SegregationResult` — the name-recovered module tree (`src/ui-server/segregation.ts`): one row per module `{id, path, bucket, package, nameSignal, nameConfidence}` sorted by id, plus disjoint `counts {screens, navigation, src, node_modules, unclassified}`, `depsApplied: boolean`, and an optional `computing: true` while a compute is in flight (see below). 404 when the project has no `module_<id>.js` files. **Never computed on the main thread**: `segregateSplitTree` runs on a `node:worker_threads` Worker (`src/workers/segregate-worker.ts`) so every other route keeps answering while it runs — measured 5 s isolated / 37-70 s loaded on Service NSW's 4,510 modules, which used to block the whole ui-server process for that entire window (the reason this route no longer computes synchronously). While no settled answer exists yet for a ctx, `segregation()` answers immediately with `{modules: [], counts: <all zero>, depsApplied: false, computing: true}` rather than blocking; `ui/src/listing/use-segregation.ts` polls every 500 ms while `computing === true` (`ui/src/panes/LeftPane.tsx` treats that placeholder exactly like `null` — flat fallback grouping — until it settles). **Persisted** in `project.hbcproj` (MIGRATION 4, `src/projdb/schema.sql`: `seg_modules`/`seg_meta`, `src/projdb/seg-cache.ts`) keyed on a hash of the module tree (`seg-cache.ts`'s `moduleTreeKey`: sorted `*.js`/`MODULES.json` file names + sizes) — a `--split` artifact with no `project.hbcproj` gets no persistence, never an error, and keeps the old in-memory-only behaviour. On the FIRST request for a ctx: a valid persisted row set is loaded and served sub-ms (no worker spawn at all); otherwise the worker runs and, once it lands, both the in-memory cache AND the DB are updated, so a ui-server restart against the SAME (unchanged) module tree serves from the DB instead of recomputing — this is OPERATIONAL cache state (spec 18 §4 boundary rule), never exported to `analysis/`, never in `log/`; losing it costs a recompute, nothing authoritative. That first landed snapshot has `depsApplied: false` (no `--hbc` deps report has run yet, so nothing lands in `node_modules/<pkg>/…`) unless a PRIOR deps-applied answer was already persisted, in which case it loads as `depsApplied: true` immediately. Once settled (from cache or from the worker), the route also starts the async deps run (`McpResources.depsReport()`, 16.5 s measured on Service NSW's 4,510 modules, offline signature-DB match — see `/api/package-id` below) and, when it settles, REPLACES the cached snapshot AND the persisted row set with one computed WITH that report (`depsApplied: true`), even when the report came back empty (no `--hbc` configured) — a settled "no deps" still flips the flag so a poll loop terminates. `ui/src/listing/use-segregation.ts` re-fetches every 5 s while `depsApplied === false` (after `computing` has cleared) and stops once `true`. The persisted cache is keyed on the module tree only, not on the deps/signature-DB identity — a `--hbc` bundle or signature DB swapped between restarts is not detected; delete `project.hbcproj`'s `seg_modules`/`seg_meta` rows (or the whole file) to force a full recompute |
  | GET | `/api/findings` | `Bounded<ResolvedFinding>` |
  | GET | `/api/leads` | `LeadsResult` |
  | GET | `/api/log/tail?since={seq}` | `LogTail` (oldest-first + `cursor`) |
  | GET | `/api/search/functions?q=&cursor=` | `SearchPage<FunctionMatch>` |
  | GET | `/api/search/source?q=&cursor=` | `SearchPage<SourceMatch>` |
  | GET | `/api/package-id/{mod}` | `PackageIdResult` — `McpResources.packageId(mod)` (spec-13's two-key gate over the module the signature DB attributes `mod` to); 400 on a non-numeric `mod`, otherwise always 200 — `{available:false, mod, reason}` is an honest answer, not a 404. Shares the SAME cached deps run `/api/segregation`'s async recompute uses (`McpResources.computeDeps()`, one run per server process) |

  These are spec 22 §3.5's routes (the server landing owns that table). If
  they change, the client is the file to change (one table, `httpApi`) —
  and this table with it.

- `ui/src/mock.ts` — the mock adapter the shell runs against until the server
  lands. Selected by `VITE_API_MOCK` (default `1`); run with
  `VITE_API_MOCK=0 npm run dev` to hit a real server. Its data is obviously
  fake and no component special-cases it.
- `ui/src/hooks.ts` — one TanStack Query hook per resource. `useLog()` polls
  `/api/log/tail` every second (spec 22 §1/§3.5's live-update wire); it polls
  from seq 0 for now, incremental cursor advance being landing 6's job.

## Theme: one config, tokens only

`ui/theme.json` is the single config:

```json
{ "preset": "dark", "overrides": {} }
```

It names a preset in `ui/themes/` (`dark.json`, `light.json`) and may
override any token path (`palette.accent`, `densities.compact.fontSize`, …).
A preset carries:

| Group | Tokens | CSS variable |
|---|---|---|
| `palette` | `bg`, `surface`, `surface-2`, `border`, `text`, `text-muted`, `accent`, `accent-fg` | `--bg`, `--surface`, … |
| `severity` | `crit`, `high`, `med`, `ok` | `--sev-crit`, … |
| `fonts` | `sans`, `mono` (with real fallback stacks) | `--font-sans-stack`, `--font-mono-stack` |
| `radius` | one radius | `--radius` |
| `spacing` | the `0..8` scale | `--space-0` … `--space-8` |
| `densities` | `compact` / `comfortable` → `unit`, `fontSize`, `rowHeight` | `--density-unit`, `--font-size`, `--row-height` |

`ui/src/theme/apply.ts` merges preset + overrides and writes them to `:root`
at startup (before the first React render). `ui/src/theme/theme.css` maps
each runtime variable onto a Tailwind theme key (`@theme inline`), so
components write `bg-surface`, `text-sev-crit`, `rounded-ui`, `font-mono` and
never a raw value.

**Density** (`comfortable` by default — the shell must not feel cramped) is a
runtime toggle in the top bar and in the command palette. It sets the root
font-size and Tailwind's `--spacing` unit, so every rem-based type size and
every padding/gap utility rescales at once; no component has a density branch.
Both densities' `unit`/`fontSize`/`rowHeight` (`ui/themes/{dark,light}.json`)
were widened for the "feels scrunched" pass — `comfortable`'s unit moved off
Tailwind's own 0.25rem default (which made "comfortable" indistinguishable
from stock) to 0.3rem, `compact` to 0.22rem — and `ui/src/theme/theme.css`'s
`body` sets `line-height: 1.5` (>= the 1.45 floor at both densities). The
preset (dark/light) and density both persist to `localStorage`
(`ui/src/theme/ThemeProvider.tsx`, keys `hbc2js.theme.preset`/
`hbc2js.theme.density`), wrapped in try/catch like every other localStorage
use in the shell.

**Art direction is a placeholder** (spec 22 §1): cool slate, `--bg #0e1520`,
`--accent #4c9be8`, IBM Plex Sans/Mono loaded from Google Fonts in
`ui/index.html` with full local fallback stacks. Fred's seed replaces the
preset values, not the structure.

### The token lint gate

`tests/gate/ui/tokens.test.ts` (node:test, no dependencies, pure file
scanning — it runs under the root `npm test` with no `ui/node_modules`
present) fails on:

- any hex colour, `rgb(`/`hsl(`/`oklch(`… call, or Tailwind literal colour
  class (`bg-slate-900`, `text-red-500`, `border-white`) in
  `ui/src/**/*.{ts,tsx,css}` or `ui/index.html`, **outside** the token layer
  `ui/src/theme/**` (and `ui/themes/*.json`, which is where colours live);
- a token present in `dark.json` but not `light.json` or vice versa;
- a `ui/theme.json` whose `preset` does not exist, or whose `overrides` name
  a token path the preset does not have;
- a preset missing a full `compact`/`comfortable` density spec.

It also asserts the detector still fires on samples, so the gate cannot
silently degrade into a no-op.

## Layout

```
+-----------------------------------------------------------------+
| top bar: project · search (stub) · density · theme · Cmd/Ctrl-K  |
+-------------+---------------------------------+-----------------+
| left >=220px| centre listing >=360px          | right >=280px   |
| Modules /   |  source   (monospace)           | ONE panel at a  |
| Leads tabs  | ------- draggable split ------- | time: Context / |
|             |  disasm  (monospace)            | Xrefs /Findings |
|             |                                 | / Package       |
+-------------+---------------------------------+-----------------+
| activity: collapsed to a status line by default                  |
+-----------------------------------------------------------------+
```

All three columns are `react-resizable-panels` panels. That library sizes in
percent, so `ui/src/usePxMinSize.ts` measures the group with a
`ResizeObserver` and converts the **pixel** minimums (`MIN_LEFT_PX` 220,
`MIN_CENTER_PX` 360, `MIN_RIGHT_PX` 280 in `ui/src/App.tsx`) into the
percentages the panels need, so a narrow window cannot squeeze a pane into
uselessness. Pane sizes persist per group via `autoSaveId`.

Right-clicking a row in the left pane opens the Radix context menu with the
spec 22 §3.3 item list (disabled until landing 4 wires the action registry).

## The listing (wave 2, track 1)

The centre pane is **CodeMirror 6**, read-only, pinned exactly
(`@codemirror/{view,state,language,lang-javascript,search,commands}`,
`@replit/codemirror-vim`, `@lezer/highlight` — all MIT). It is dressed
entirely in tokens: `ui/src/listing/cm-theme.ts` is one
`EditorView.theme({...})` plus one `HighlightStyle.define([...])` whose every
value is a `var(--token)`, because CodeMirror's own `defaultHighlightStyle`
is full of hex literals and would smuggle art direction past the token gate.

**A file, not a function.** Selecting a module in the tree loads
`GET /api/module/:id/source` — the whole module text plus the line range of
every function in it — and renders it. Selecting a function keeps the *same
document* and scrolls to its range (marked in the gutter margin by the
`hbc-fn-start` decoration); clicking anywhere inside a marked range selects
that function. Only when a module has no file view (404) does the pane fall
back to `GET /api/fn/:fn/source`. `GET /api/fn/:fn/disasm` fills the lower
half of the vertical split, which folds away entirely from the bar at the
bottom of the pane.

**Selection** lives in `ui/src/state/selection.ts`: a `useSyncExternalStore`
store (no new dependency, no context provider, so keymap handlers and the
action registry can read it from outside React) whose `Selection` is a
field-for-field copy of `Selection` in `src/ui-core/actions.ts`, plus a
`line`. It carries the spec 22 §3.2 jump list (`back()`/`forward()`, capped
at 100). A single click on a word in the listing sets
`{kind:"identifier", fn, name, line}` — that is exactly what Rename and the
annotate actions consume. `tests/gate/ui/listing.test.ts` fails if the two
`Selection` shapes drift apart.

**Names.** Three sources disagree: `/api/fn/:fn` reports `name` and
`overlayName`, but an *accepted* rename appears only as
`metadata.acceptedName` on `/api/fn/:fn/context`. `ui/src/listing/names.ts`
resolves `acceptedName > overlayName > name > "fn N"` and every pane that
shows a function name goes through it.

**Screens first.** A real Metro bundle carries no module paths at all —
`ModuleEntry.file` is `module_<id>.js` for every one of Service NSW's 4 510
modules — so grouping the tree by `file` puts everything in one `src/` group.
The tree therefore groups by `GET /api/segregation` instead
(`groupModulesSegregated` in `ui/src/listing/modules.ts`): **Screens**,
**Navigation**, **App**, one group per `node_modules/<pkg>` alphabetically,
then **Unclassified** last and collapsed. Screens and Navigation are open by
default, because screens are what an analyst debugs first. A module's label is
the basename of its recovered path (`HomeScreen.js`) with `module_<id>` kept
as a dim secondary label so the id is never lost. When `/api/segregation` is
unavailable (404, or the mock adapter) the tree falls back to `groupModules`
below — never a blank tree. While the request is still in flight the pane says
"recovering module names…" instead: the fallback is for a server that *cannot*
segregate, not for one that has not answered yet, and painting the flat tree
first would reshuffle every row under the analyst's cursor a moment later.

**Bounded by construction.** The left tree lists modules from
`GET /api/modules` grouped into the app's own `src/` modules and one group
per `node_modules/<pkg>` (`ui/src/listing/modules.ts`), and only fetches
functions for the modules that are *open*, from their file views — a real
bundle has 15 000 functions, so walking `/api/functions?cursor=` (the
`useFunctionCatalogue` hook, kept for callers that want the whole catalogue;
it now asks for `?limit=1000` a page — `FUNCTIONS_PAGE_MAX`,
`src/ui-server/list.ts` — instead of the route's 50-row default, so the
walk that used to cap out at 200×50=10,000 functions, silently dropping a
third of Service NSW's ~15,000, is 15 requests, not 300) would still be a
lot of requests to fill a tree that shows a dozen rows. The editor renders
at most `MAX_RENDER_LINES` (5 000) lines and says how many it hid
(`ui/src/listing/truncate.ts`), on top of the server's own truncation. The
top bar's search is `GET /api/search/functions`: a dropdown of at most 50
hits, `Enter` takes the first, and while a query is present the left pane
shows the hits as a flat list instead of the tree.

**Virtualised.** The tree is windowed by `@tanstack/react-virtual` (pinned
exact, `ui/package.json`): `ui/src/listing/modules.ts`'s `flattenTree` turns
the grouped tree (groups → open modules → open modules' functions) into one
flat row array, and `ui/src/panes/LeftPane.tsx` mounts only the rows the
viewport (plus a 12-row overscan) can show, via `useVirtualizer`. Everything
the pre-virtualisation tree had keeps working against the flattened rows:
expand/collapse, selection highlight, the roving-focus keyboard cursor
(`ArrowUp`/`ArrowDown` call `virtualizer.scrollToIndex` so the cursor never
walks off-screen), the search filter (`filterGroups` still runs over the
WHOLE grouped tree, not the rendered window — search results are a separate
non-virtualised list, capped at 100 modules / 200 functions same as before),
the right-click context menu, and the `!seg.isLoading` auto-select-first-
module guard. New: picking a module from a search hit now also opens its
group (`toggleGroup`), and a `scrolledForSelection` effect calls
`virtualizer.scrollToIndex` whenever the selected module/fn's row resolves
in the flattened array — covering both the back/forward jump list and
"select a search hit, then clear the query". A function selected from a
*function*-search hit still cannot be scrolled to in the tree if its module
is closed: `search/functions` returns fn ids with no module id (the same
"15,000 requests to resolve" constraint noted above), so there is nothing to
open.

Measured on the live Service NSW rig (4,510 modules; `ui/src/theme` default
density/tokens, Screens+Navigation open by default — Unclassified, the
other 4,316 modules, stays collapsed): a same-page build against the SAME
`:7331` ui-server, before vs. after, `[data-tree="modules"] *` node count and
the count of rendered `[data-group]`/`[data-module]`/`[data-fn]` rows —

| | DOM nodes under the tree | rendered rows |
|---|---|---|
| before (no virtualisation) | 1,026 | 210 |
| after (virtualised) | 172 | 31 |

— an 83% cut in DOM nodes and rendered rows with the same two groups open,
even though Unclassified (the group that actually has thousands of modules)
was never opened in this measurement; opening it is exactly the case
virtualisation exists for, since the old tree would have mounted all 4,316
of its rows at once. Time-to-interactive (`page.goto` → first `[data-module]`
visible) was NOT a clean signal on this box: a cold run measured 51.6s
before / 21.3s after, but a second, warm run measured 9.0s / 9.7s — the
number is dominated by `/api/segregation`'s cache state and other agents'
concurrent load on the shared box, not by tree rendering, so it is reported
here for completeness but the DOM-node counts above are the metric this
landing actually moved.

**Back / forward.** The top bar carries the jump list's two arrows, left of
the breadcrumbs. They dispatch `navigate.back` / `navigate.forward` through
`runAction` (`ui/src/actions/registry.ts`), never `back()`/`forward()` on the
store, so the buttons and the keymap are one path; their disabled state comes
from `useJumpState()` and their tooltips read the chord out of the live keymap
plus the current "N of M" position in the list.

**Keyboard.** The tree is a roving-focus list: the container holds focus,
Up/Down move a cursor over the visible rows, Enter opens, Left/Right
collapse and expand. Every function row carries `data-fn`, so the keymap
track can drive the list without a React handle. The vim layer is present
but mounted only when `ui/keymap.json` says `"preset": "vim"`
(`ui/src/keymap-config.ts`). The listing installs no `contextmenu` handler
and stops no events, so right-clicks reach the annotate track's menu.

## What is stubbed (landing 1 is the shell, not the app)

- **Source↔disasm alignment**: the two blocks are independent editors; the
  disasm is not scrolled to the source line (no line→offset map in the UI
  yet).
- **The command palette** (`Cmd/Ctrl-K`) lists hard-coded items, of which
  only the theme and density toggles run; the action registry, keymap and
  vim preset are landing 4.
- **The context menu** items are disabled; rename/comment through `McpTools`
  is landing 5.
- **The activity pane** is live (see "Activity feed" below) — this bullet
  is now historical.
- ~~No virtualisation~~ FIXED: the tree is windowed by
  `@tanstack/react-virtual` (see "Virtualised" above); the editor is still
  capped at 5 000 rendered lines rather than windowed (`ui/src/listing/
  truncate.ts`) — a real listing pane, not a graph view, so a fixed cap plus
  a truncation notice is enough for now. No graph view, no worker/jobs rail
  bullet applies here (the AI tab landed separately, see "AI workers"
  below); no further Playwright smoke gaps known.

## Actions, keymap, context menu, annotate (wave 2, track 2)

This section supersedes the "command palette lists hard-coded items" and
"context menu items are disabled" bullets under *What is stubbed*.

**One registry, three views.** `ui/` imports the repo-root
`src/ui-core/{actions,keymap,keymap-resolve}.ts` through the `@ui-core`
alias (declared twice, in `ui/vite.config.ts` and in `ui/tsconfig.json`'s
`paths`; `tests/gate/ui/actions-registry.test.ts` fails if either goes
missing). `createStandardRegistry()` is the ONLY list of commands in the
shell: the context menu (`contextMenuFor`), the palette (`paletteItems`) and
the keymap all read it. Adding an action to `src/ui-core/actions.ts` — plus
a chord in `src/ui-core/presets/*.json` — makes it appear in all three.

**Keymap.** `ui/keymap.json` is `{ preset, overrides }`; `preset` is
`default` | `vim` | `ghidra`, `overrides` maps a chord to an action id (or
`null` to unbind). `ui/src/keymap-config.ts` imports the preset JSON through
the alias and `ui/src/actions/registry.ts` resolves it with
`resolveKeymapConfigWith` — an override naming an unknown action id throws at
startup, not at keypress. `ui/src/actions/keys.ts` is the DOM adapter: one
`window` keydown listener, normalising to ui-core `KeyEvent`s. It ignores
keys typed in an `input`/`textarea`/`select`/contenteditable, anything inside
`[data-hbc-keys="off"]` (the dialogs, the palette, the menu), and the
CodeMirror editor while the vim layer is in INSERT mode (no `cm-fat-cursor`
class). A pending multi-key sequence shows as a chord indicator bottom-right.

**Context menu.** Radix `ContextMenu`, items from `contextMenuFor` with the
chord at the right. It is opened from a document-level listener in the
CAPTURE phase (`ui/src/components/ContextMenu.tsx`) rather than by wrapping
panes in a trigger: the centre pane is CodeMirror and the tree belongs to
track 1, neither is ours to edit, and CodeMirror swallowed the right-click so
the browser's native menu appeared over the source. The listener
`preventDefault()`s every right-click that is not in a real text field (where
the native copy/paste menu is what you want), derives the identifier under
the pointer with `caretPositionFromPoint`/`caretRangeFromPoint`, then
re-dispatches a synthetic `contextmenu` onto a 1px Radix trigger placed at
those coordinates — Radix keeps positioning, keyboard nav and focus return.
Synthetic events are `isTrusted === false`, which is how it avoids re-entry.

**Writes.** `ui/src/actions/writes.ts` POSTs to `/api/tools/*`, i.e. exactly
`McpTools`, so a UI rename is logged, exported and hash-locked like an MCP
client's. Targets are STRINGS (`fn:7992`), provenance is
`{source:"human", who:"ui"}`. On refusal the server's `reason` is shown
VERBATIM in the form — e.g. `record_finding: rejected — a finding needs >=1
evidence ref and at least one must resolve`. After a successful write the
`fn`/`source`/`disasm`/`context`/`who-calls`/`calls-from` queries for that
function plus `functions-all`, `findings` and `log-tail` are invalidated.

| Action | Surface | Route |
|---|---|---|
| `annotate.rename` (`F2`, vim `cr`) | inline dialog, pre-filled with the accepted name, showing call sites + context xrefs before confirm | `POST /api/tools/set-name` |
| `annotate.comment` (`Ctrl-/`, vim `gc`) | textarea dialog | `POST /api/tools/add-comment` |
| `annotate.finding` (`Ctrl-Shift-N`, vim `cf`) | "Add finding" button in the Findings panel, plus menu and palette | `POST /api/tools/record-finding` |
| `review.markReviewed` / `markSuspicious` | menu, palette | `POST /api/tools/add-tag` |

**Names.** `McpResources.fn` adds `acceptedName` on top of the artifact's
`name`/`overlayName`; `ui/src/actions/names.ts`'s `displayName()` is the one
place that resolves the precedence (accepted > overlay > artifact) and the
right pane uses it — without it a rename looks like it did nothing.

**Renaming a local.** Right-clicking an identifier in the source pane renames
THAT binding. The clicked token is resolved against `GET /api/fn/{fn}/locals`
(`src/ui-core/rename-target.ts`, unit-tested in `tests/ui-core/`), whose
`rendered` column is the identifier as the served source shows it — so `r3`
(passes-off) and an already-renamed `count` both resolve to their register —
and the write targets `reg:<fn>:<reg>`. The context menu names the token
(`Rename "r3"`) and the dialog's subtitle always states the exact target plus
the number of references in the frame. A token that is NOT a nameable local
(a property, a keyword, a global) still renames the enclosing function, and the
subtitle says why. After the write, `invalidateFn` refetches `source`,
`context` and `locals`, so the new name is on screen immediately.

Server side, the accepted `reg:F:R` names live in the project DB's `d_names`
(the same slot every `set_name` writes). `ProjectService` injects a lookup into
`ArtifactService` (`setActiveNames`), and `source(fn)` then serves
`renderFn(fn)` — ONE function re-emitted through
`src/name-overlay/render.ts`'s `renderFrame`, memoised per function and
invalidated on write — instead of the file on disk. The name is applied as the
same guarded frame-local alpha-rename `var-naming` uses, so renaming can never
change what the code does, and it stops at function boundaries: an inner
function's own `r3` is a different binding and is left alone.

**Still rough here.** String targets (`sid:N`) are not wired — renaming a
string literal is a contract change, not a binding rename, and has no store.
The whole-module view (`GET /api/module/{id}/source`) serves the rendered file
from disk and is NOT overlay-aware: a renamed local shows in the function
source pane and in `/api/fn/{fn}/context`, but the module file still shows the
old identifier until the artifact is re-rendered. The per-function re-render
also uses this build's live decompile defaults, and stage-B passes only when
the manifest recorded some (`src/split/index.ts` runs none unless `--passes`
was given), so a re-rendered function can differ cosmetically from the on-disk
text — its line numbers are its own, not the module file's. `list`'s
`rendered` column is exact for a named register and best-effort for a
var-named one (it classifies the same raw frame body `var-naming` classifies).
`view.fold` / `view.unfold`, `view.rawHermes` and `ai.*` are status-line stubs;
`view.copyDisasmOffset` copies `fn:<n>`, not a byte offset. The Package panel
reads the real `GET /api/package-id/{mod}` (wave 4a).

## Activity feed (wave 2, track 3)

The bottom pane (`ui/src/panes/BottomPane.tsx`) is collapsed to a one-line
status bar by default and expands into two tabs, both reading the same live
data from `useLog()` (`ui/src/hooks.ts`):

- **Activity** (`ui/src/activity/ActivityFeed.tsx`) — one compact line per
  row (`HH:MM:SS who op summary`), newest at the bottom, auto-scrolling
  unless the viewer has scrolled up (a 24 px slop on "at the bottom", so
  sub-pixel scroll rounding does not fight the auto-scroll). Clicking a row
  whose `detail` names a function (`ui/src/activity/format.ts`'s
  `targetFn()` — reads `detail.target`/`detail.fn`; today's server payloads
  do not populate either, so this is forward-compatible rather than
  exercised yet) selects it via `select({kind:"fn", fn})`
  (`ui/src/state/selection.ts`).
- **Log** (`ui/src/activity/LogTab.tsx`) — the raw rows (`seq`, `ts`, `who`,
  `op`, `detail` verbatim) in a monospace list, filterable by a `who`/`op`
  substring box.

Collapsed state and the active tab persist to `localStorage`
(`ui/src/activity/store.ts`, keys `hbc2js.activity.collapsed`/
`hbc2js.activity.tab`), wrapped in try/catch so a private-browsing tab
degrades to in-memory state rather than throwing. The header shows an
unread-count badge whenever there is activity the viewer has not seen —
either because the pane is collapsed, the "Log" tab is active, or the
"Activity" tab is scrolled up; `BottomPane` and `ActivityFeed` share one
`seenSeq` high-water mark for this (`ActivityFeed` owns it while mounted and
reports back through `onSeenChange`, `BottomPane` computes it directly from
`rows` otherwise) so the count never drifts out of sync with what has
actually scrolled past.

**Transport (`useLog`, `ui/src/hooks.ts`).** Prefers the server's SSE
endpoint, `GET /api/events` (`src/ui-server/server.ts`'s `serveEvents`):
one `EventSource` against `${API_BASE}/api/events`, listening for its `log`
events, each a JSON `LogTail` (`{rows, cursor}`). If `EventSource` errors —
or is unavailable, or the app is running against the mock adapter
(`VITE_API_MOCK=1`, which has no server to connect to) — `useLog` falls
back to polling `GET /api/log/tail?since=<cursor>` every 1 s
(`LOG_POLL_MS`). Both paths append through the same idempotent `append()`
(rows are filtered to `seq > cursor` before merging, so a race between a
late poll response and a fresh SSE frame cannot double an entry), so a
mid-session SSE hiccup that falls back to polling picks up exactly where it
left off. Kept as a `useQuery` under the `["log-tail"]` key (rather than a
bare interval) specifically so `ui/src/actions/registry.ts`'s post-write
`invalidateQueries({queryKey:["log-tail"]})` still forces an immediate
refetch while polling is the active source.

**Cursor semantics.** `/api/log/tail`'s own contract (`docs/specs/22-ui-mvp.md`
§3.5): rows oldest-first with `seq > since`, plus `cursor` (the highest
`seq` returned, poll again with that). `useLog` keeps at most
`LOG_FEED_MAX_ROWS` (500) rows in memory, oldest dropped first — the bottom
pane is a live tail, not a full-session log browser (that is what the "Log"
tab's filter, plus `GET /api/log?since=&who=`/`generate_documentation` on
the MCP side, are for).

**What a line shows.** `ui/src/activity/format.ts`'s `summarize()` turns
`op` + `detail` (a JSON string whose shape is the writer's, not a typed
contract — `src/projdb/ix-write.ts`'s `init`/`rebuild-index` rows,
`src/projdb/revision-store.ts`/`rebuild.ts`'s `annotate`/`revert` rows) into
one clause: `init` → "project initialised"; `rebuild-index` with a
`functions` count → "project initialised: 43,384 functions"; `annotate`/
`revert` with `{"kind":...}` → "renamed"/"commented"/"tagged"/"bookmarked"/
"finding recorded"/"status changed" (revert prefixes "reverted (...)" ).
Anything unrecognised falls back to the raw `op` and JSON `detail` rather
than throwing — verified directly against the live Service NSW project
server (`seq 1`–`4`: `init`, `rebuild-index {functions:43384,...}`,
`annotate {kind:"name"}`, `annotate {kind:"comment"}`).

## AI workers (the "AI" tab)

The right pane's third tab is spec 23's surface: what the server-owned
workers are doing, who else is here, and what they have proposed for the
selected function. It is deliberately the least magical panel in the shell —
every AI-produced row says who proposed it and which job run produced it, and
nothing it shows is truth until a human presses Accept.

**Jobs rail.** Every job with its status (`queued`/`running`/`done`/`failed`/
`cancelled`), kind, target and elapsed time, newest work visible immediately
because the rail polls `/api/jobs` once a second. `Cancel` on a queued or
running job is a guarantee about *writes*, not about processes (spec 23
§2.3): a job cancelled mid-flight writes nothing at all. The header shows the
backend id and the concurrency cap the pool runs at.

**Presence.** A chip per live participant from `/api/sessions` — humans,
the worker pool, and any external MCP client that opened a session. "Live"
is computed on read against the TTL, so a crashed UI cannot leave a ghost
sitting in the list.

**Suggestions.** For the selected function, the `tier:"suggested"` names and
the `[ai-suggested]` comments. `Accept` on a name calls
`/api/suggestions/promote`, which re-records it through the ordinary
`set_name` path under **the human's** provenance — that write is logged,
exported and hash-locked exactly like a rename typed by hand. `Reject`
writes nothing: the row greys out and the suggestion survives as history
(the note is kept on the job row, which is operational state and never
reaches a shard).

**Queuing work.** "Suggest name" and "Explain" enqueue a job for the selected
function. They are also the `ai.suggestName` / `ai.explain` actions, so the
command palette, the context menu and any keybinding pointed at them do the
same thing — enabled as of spec 23, on an fn target only.

The default backend is offline and deterministic (`HeuristicBackend`: names
from the function's own callees and strings), so the loop works with no API
key and no network. `hbc2js ui-server … --workers off` turns the pool off
entirely; the tab then says so instead of drawing an empty rail, because the
routes answer 503 rather than an empty list.

## Smoke test (Playwright)

`ui/e2e/` (`@playwright/test`, pinned exact, a `ui/`-only devDependency —
the root package stays zero-runtime-dependency) drives the built shell
through a real browser (Chromium, `npx playwright install chromium`) against
a real `ui-server`, not the mock adapter. Two ways to run it:

- `cd ui && npm run e2e` — builds a throwaway project from
  `tests/fixtures/bundles/rn-template-0.72/index.android.hbc`
  (`ui/e2e/prepare-fixture.mjs`, via `hbc2js init`) and a throwaway
  `ui/dist` build (`VITE_API_MOCK=0 VITE_API_BASE=http://127.0.0.1:7341`)
  into `$TMPDIR/hbc2js-ui-e2e/`, then starts our OWN `ui-server` on `:7341`
  (API only) and `vite preview` on `:7342` serving that throwaway dist — the
  fixture run **never touches the shared `ui/dist/`** the live rig's `vite
  preview` serves, exactly so a local smoke run cannot disturb Fred's
  already-running `:4173`/`:7331` rig. Playwright's own `webServer` config
  starts and stops both processes; nothing is left running after the test
  exits.
- `cd ui && npm run e2e:nsw` — the same spec, `PW_BASE_URL=http://127.0.0.1:4173`
  and `PW_READONLY=1`: no `webServer` entries at all (it never starts, never
  restarts, never rebuilds anything), points straight at Fred's live rig,
  and skips the one write step (rename). Response times there scale with the
  bundle: `/api/segregation` on a 4,510-module bundle can take up to ~70s on
  a loaded box (see "Screens first" above) — `ui/e2e/smoke.spec.ts`'s `WAIT`/
  `SHORT_WAIT` constants and `playwright.config.ts`'s per-test `timeout`
  both scale up automatically when `PW_BASE_URL` is set, rather than the
  fixture run's tight defaults.

What it exercises: page loads with no console/page error beyond one
documented, not-yet-fixed one (see below); the module tree renders groups,
expands one, and a module click shows its file in the centre pane; a
function click updates the right pane's Context tab; right-click on code
opens the context menu (Radix), Escape closes it, "Rename" opens the dialog
and Cancel closes it without writing; back/forward restore prior selections;
the search box finds and selects a function; and (fixture run only) a
submitted rename shows up as `Context`'s `name` row and produces at least
one Activity row.

**Known, reported, not fixed here:** on first paint `App.tsx` defaults the
selected `fn` to `0` (`useSelection().fn ?? 0`) before anything is actually
selected, so `RightPane`/`CenterPane` query `/api/fn/0/context` etc.
immediately; fn 0 (the global function) has no recorded source range and
answers 400, which the browser logs as a console error on every fresh load
regardless of application code. Fixing it means threading
`fn: number | undefined` through `RightPane.tsx` so it can skip the query
instead of collapsing "nothing selected" into fn 0 — `RightPane.tsx` is
owned by a different concurrent track, so this was reported rather than
edited; `ui/e2e/smoke.spec.ts`'s console-error test allowlists exactly this
one known signature and still fails on anything else.

A real bug the suite caught and a fix that shipped with it: `LeftPane.tsx`'s
auto-select-first-module effect could fire while `GET /api/segregation` was
still loading, against the FALLBACK grouping's keys (`groupModules`, e.g.
`"app"`) rather than the segregated grouping's keys (`groupModulesSegregated`,
e.g. `APP_KEY` = `"seg:app"`) — once the real segregation answer landed
moments later the effect's `sel.kind !== "none"` guard stopped it from ever
re-running, so the analyst landed on a module that LOOKED selected but whose
group stayed permanently collapsed. The effect now also waits on
`!seg.isLoading`, same as the tree body's own render gate.
