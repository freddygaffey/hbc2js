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
  | GET | `/api/fn/{fn}/context` | `FnContext` |
  | GET | `/api/fn/{fn}/callers` | `WhoCalls` |
  | GET | `/api/fn/{fn}/callees` | `CallsFrom` |
  | GET | `/api/module/{id}` | `ModuleInfo` |
  | GET | `/api/module/{id}/source` | `ModuleSource` — whole file text + every owned fn `{fn,name,lines}`; the FILE view (select a module, see all its functions; per-function focus is optional, not forced) |
  | GET | `/api/findings` | `Bounded<ResolvedFinding>` |
  | GET | `/api/leads` | `LeadsResult` |
  | GET | `/api/log/tail?since={seq}` | `LogTail` (oldest-first + `cursor`) |
  | GET | `/api/search/functions?q=&cursor=` | `SearchPage<FunctionMatch>` |
  | GET | `/api/search/source?q=&cursor=` | `SearchPage<SourceMatch>` |
  | GET | `/api/package-id/{mod}` | `PackageIdResult` — **not in spec 22 §3.5's route table**; the Package panel stays on the mock until the server publishes it |

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

**Bounded by construction.** The left tree lists modules from
`GET /api/modules` grouped into the app's own `src/` modules and one group
per `node_modules/<pkg>` (`ui/src/listing/modules.ts`), and only fetches
functions for the modules that are *open*, from their file views — a real
bundle has 15 000 functions, so walking `/api/functions?cursor=` (the
`useFunctionCatalogue` hook, kept for callers that want the whole catalogue)
would be 300 requests to fill a tree that shows a dozen rows. The editor
renders at most `MAX_RENDER_LINES` (5 000) lines and says how many it hid
(`ui/src/listing/truncate.ts`), on top of the server's own truncation. The
top bar's search is `GET /api/search/functions`: a dropdown of at most 50
hits, `Enter` takes the first, and while a query is present the left pane
shows the hits as a flat list instead of the tree.

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
- **The activity pane** shows mock log rows; real 1 s polling of a live
  project's log arrives with the server (landing 6).
- No virtualisation (spec 22 §2 accepts it): the tree renders every open
  module's rows and the editor is capped at 5 000 lines instead. No graph
  view, no worker/jobs rail, no Playwright smoke test yet.
