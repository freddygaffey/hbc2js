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
  | GET | `/api/fn/{fn}/linemap` | `LineMap` — `{fn, fnStartLine, lines: [[line, fn, start, end], …]}`, the honest-partial source↔disasm map (`docs/specs/05-emitter.md` §16). `line` is 1-based inside the function's own served text, `fnStartLine` that text's first line in the module file, and `[start, end)` the byte range of the ONE instruction behind the line, within function `fn` — usually the function being rendered, but a nested closure printed inside its parent contributes rows of its own. Sorted, at most one row per line, uncapped (a truncated map would be a *wrong* map for the lines it dropped). `lines: []` — never a 404 — when the server has no `--hbc` or the function has no emitted frame |
  | GET | `/api/fn/{fn}/locals` | `{rows:[{reg,rendered,named,role,uses}],total}` |
  | GET | `/api/fn/{fn}/context` | `FnContext` |
  | GET | `/api/fn/{fn}/callers` | `WhoCalls` |
  | GET | `/api/fn/{fn}/callees` | `CallsFrom` |
  | GET | `/api/module/{id}` | `ModuleInfo` |
  | GET | `/api/module/{id}/source` | `ModuleSource` — whole file text + every owned fn `{fn,name,lines}`; the FILE view (select a module, see all its functions; per-function focus is optional, not forced) |
  | GET | `/api/segregation` | `SegregationResult` — the name-recovered module tree (`src/ui-server/segregation.ts`): one row per module `{id, path, bucket, package, nameSignal, nameConfidence}` sorted by id, plus disjoint `counts {screens, navigation, src, node_modules, unclassified}`, `depsApplied: boolean`, and an optional `computing: true` while a compute is in flight (see below). 404 when the project has no `module_<id>.js` files. **Never computed on the main thread**: `segregateSplitTree` runs on a `node:worker_threads` Worker (`src/workers/segregate-worker.ts`) so every other route keeps answering while it runs — measured 5 s isolated / 37-70 s loaded on Service NSW's 4,510 modules, which used to block the whole ui-server process for that entire window (the reason this route no longer computes synchronously). While no settled answer exists yet for a ctx, `segregation()` answers immediately with `{modules: [], counts: <all zero>, depsApplied: false, computing: true}` rather than blocking; `ui/src/listing/use-segregation.ts` polls every 500 ms while `computing === true` (`ui/src/panes/LeftPane.tsx` treats that placeholder exactly like `null` — flat fallback grouping — until it settles). **Persisted** in `project.hbcproj` (MIGRATION 4, `src/projdb/schema.sql`: `seg_modules`/`seg_meta`, `src/projdb/seg-cache.ts`) keyed on a hash of the module tree (`seg-cache.ts`'s `moduleTreeKey`: sorted `*.js`/`MODULES.json` file names + sizes) — a `--split` artifact with no `project.hbcproj` gets no persistence, never an error, and keeps the old in-memory-only behaviour. On the FIRST request for a ctx: a valid persisted row set is loaded and served sub-ms (no worker spawn at all); otherwise the worker runs and, once it lands, both the in-memory cache AND the DB are updated, so a ui-server restart against the SAME (unchanged) module tree serves from the DB instead of recomputing — this is OPERATIONAL cache state (spec 18 §4 boundary rule), never exported to `analysis/`, never in `log/`; losing it costs a recompute, nothing authoritative. That first landed snapshot has `depsApplied: false` (no `--hbc` deps report has run yet, so nothing lands in `node_modules/<pkg>/…`) unless a PRIOR deps-applied answer was already persisted, in which case it loads as `depsApplied: true` immediately. Once settled (from cache or from the worker), the route also starts the async deps run (`McpResources.depsReport()`, 16.5 s measured on Service NSW's 4,510 modules, offline signature-DB match — see `/api/package-id` below) and, when it settles, REPLACES the cached snapshot AND the persisted row set with one computed WITH that report (`depsApplied: true`), even when the report came back empty (no `--hbc` configured) — a settled "no deps" still flips the flag so a poll loop terminates. `ui/src/listing/use-segregation.ts` re-fetches every 5 s while `depsApplied === false` (after `computing` has cleared) and stops once `true`. The persisted cache is keyed on the module tree only, not on the deps/signature-DB identity — a `--hbc` bundle or signature DB swapped between restarts is not detected; delete `project.hbcproj`'s `seg_modules`/`seg_meta` rows (or the whole file) to force a full recompute |
  | GET | `/api/screens` | `ScreensResult` (spec 26 L4, `src/ui-server/screens.ts`) — the hierarchical screens tree: `{screens: [{mod, fn, label, kind, children, navigatesTo}], total}` plus an optional `computing: true` mirroring `/api/segregation`'s placeholder. `kind` is `screen`/`navigator` exactly as `src/split/segregate.ts` placed the module (`src/screens/…` / `src/navigation/…`) — this route never re-detects a navigator and never guesses from a name. `fn` is the module's lowest-indexed owned function (what "open this screen" selects), `null` when the artifact records none. `children` are module ids of OTHER rows in the same answer: the module's own recorded dependencies, restricted to screens, claimed by at most one parent and never closing a cycle, so the answer is always a forest. `navigatesTo` rows carry their provenance: `confidence: "points-to"` ONLY when the `require(N)` points-to index (`index/calls-resolved.jsonl`, spec 17 §14.4) proved the call — a direct `calls.jsonl` edge is never promoted to one — and `confidence: "by-name"` for a `navigate("X")`-family literal in the screen's own decompiled text that matches another screen's label (a name match, drawn dashed, never a proven edge). Edges to a module that is not itself a screen row are dropped, not returned as stubs. 404 when the project has no `module_<id>.js` files, same condition as `/api/segregation`. Computed once per server process, after segregation has settled |
  | GET | `/api/findings` | `Bounded<ResolvedFinding>` |
  | GET | `/api/leads` | `LeadsResult` |
  | GET | `/api/object-tables?minProps=&stringRatio=&key=&value=&minMatched=&module=&limit=` | `ObjectTables` — the bundle-wide constant-object-literal ("endpoint tables") inventory, spec 17 §14.2. Live: needs the server's `--hbc`; each table is inlined with the containing function's `fnName`/`size` and with `matched` (members hit by `key`/`value`). A filtered query is ranked by `matched`, then hit density, then size — not by size alone, or a 2,125-member HTML-entity table wins on `value=^/` |
  | GET | `/api/template-injections?module=&limit=` | `TemplateInjections` — bundle-wide WebView-injection anti-pattern scan (hunt lead C1), spec 17 §14.3. Live: needs the server's `--hbc`; each row is inlined with the containing function's `fnName`/`size`. Ranked by substitutions-inside-quotes desc, then `fn`. **Contracts only — no UI pane yet.** |
  | GET | `/api/log/tail?since={seq}` | `LogTail` (oldest-first + `cursor` + ADDITIVE `targets: string[]`, spec 26 L1 — the `fn:N`/`mod:N` ids the batch's rows name; old clients ignore it) |
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
- `ui/src/hooks.ts` — one TanStack Query hook per resource. `useLog()`
  prefers `GET /api/events` (SSE, doorbell-driven since spec 26 L1 — see
  "Live update" below), falling back to polling `/api/log/tail` with an
  incrementally-advancing cursor.

## Cold start

`/api/fn/{fn}/locals` and `/api/module/{id}/source` are the two LIVE routes
(§ above, `list`/`context`/render) that need the frame bodies
`ArtifactService.ensureFrames()` builds from bytecode
(`analyseModule({strictEnv:true})` then `rawFrames`) — never on disk in the
artifact, and the SAME work `/api/segregation`'s worker-thread note above
describes for the module tree. On a large bundle this is expensive and, unlike
segregation, cannot be moved to a `worker_threads` worker without a much
larger `src/cfg` refactor: the `ModuleAnalysis` object closes over local
helpers, so `structuredClone` throws on it (measured on Service NSW's 4,510
modules / ~15k functions: `analyseModule` ~5.6 s, `rawFrames` ~58.5 s of a
~65 s total — the dominant cost, and the reason a future `rawFrames` `indices`
option, mirroring `emitModule`'s function-subset support once it exists, is
the real fix, not attempted here).

`startUiServer` (`src/ui-server/server.ts`) prewarms this analysis right
after `listen`, mirroring the existing `/api/segregation` prewarm: by the time
a browser asks, the frames are often already there instead of the first
`/locals`/`/source` request freezing every other route for the full
computation. `ArtifactService.warmFrames()` is the shared entry point — a
prewarm call and a request that reaches the live-frame path first (the race
is possible; the computation itself stays synchronous, on the main thread)
never run `analyseModule` twice, since both funnel through the same
`this.analysis === undefined` memoisation `ensureFrames` already had. `--no-
prewarm` (CLI) / `prewarm: false` (`startUiServer` option) skips it — the
test suite uses this so a tiny fixture bundle never warms work nothing asks
for. While a locals/source query has been in flight for over a second, the
centre pane says "analysing the bundle (first request after start is slow)"
instead of a bare "loading listing…" (`ui/src/panes/CenterPane.tsx`'s
`useSlowLoading`).

## First paint (what the load path may cost)

Measured 2026-09-05 against the live Service NSW rig, written up in
`docs/reports/2026-09-05-ui-first-paint.md`: a refresh showed nothing for
42 s. The server is ONE single-threaded Node process, so **any route that
blocks for seconds blocks every other route behind it** — `/api/segregation`,
`/api/findings` and `/api/log/tail` each cost 0–3 ms of server time and still
landed 41 s late, queued behind one `/api/leads`. Two rules follow, and they
are what the perf regression test (`ui/e2e/perf.spec.ts`) enforces:

* **The load path is `modules` + `segregation` + `findings` + `log/tail`, and
  nothing else.** A pane that wants an expensive resource asks for it when
  the analyst opens it, not on mount: `useLeads(enabled)` is fetched only
  once the left pane's Leads tab has been opened (`ui/src/panes/
  LeftPane.tsx`), exactly as `useWhoCallsByName(fn, enabled)` already was for
  the Xrefs tab. Adding an unconditional `useX()` to a mounted pane is how
  this bug happens again.
* **A whole-bundle scan is computed once per artifact, in this layer.**
  `/api/modules` reads `ix_modules`/`ix_module_deps` alone (not
  `loadIndexRowsFromDb`, which materialises every index to return one:
  3.15 s → 17 ms on NSW) and caches per artifact `mtime:size`; `/api/leads`
  and `/api/leads/security-sinks` go through `listLeads`, memoised per
  `ArtifactService` (`src/ui-server/list.ts`). Both are safe because the
  artifact indices are `renderIndependent` — no annotation a write tool
  records can change them.

The HTTP contract is unchanged by all of this: same routes, same bodies,
byte for byte.

## Theme: one config, tokens only

`ui/theme.json` is the single config:

```json
{ "preset": "dark", "overrides": {} }
```

It names a preset — any file in `ui/themes/*.json`, loaded with
`import.meta.glob` (`ui/src/theme/apply.ts`), so adding a preset is "drop a
JSON file in `ui/themes/`", not a code change — and may override any token
path (`palette.accent`, `densities.compact.fontSize`, …). A preset carries:

| Group | Tokens | CSS variable |
|---|---|---|
| `palette` | `bg`, `surface`, `surface-2`, `border`, `text`, `text-muted`, `accent`, `accent-fg` | `--bg`, `--surface`, … |
| `severity` | `crit`, `high`, `med`, `ok` | `--sev-crit`, … |
| `fonts` | `sans`, `mono` (with real fallback stacks) | `--font-sans-stack`, `--font-mono-stack` |
| `radius` | one radius | `--radius` |
| `spacing` | the `0..8` scale | `--space-0` … `--space-8` |
| `densities` | `compact` / `comfortable` → `unit`, `fontSize`, `rowHeight` | `--density-unit`, `--font-size`, `--row-height` |
| `mode` | `"dark"` \| `"light"` — which half of the light/dark toggle (bur 6) | — |
| `family` | e.g. `"gruvbox"` — groups a palette's dark/light variants (bur 6) | — |
| `type` (L3, spec 20 §1.2) | the type ramp: `xs`, `sm`, `base`, `lg` — the ONLY font sizes a component may use, via the `text-xs/sm/base/lg` Tailwind utilities | `--type-xs` … `--type-lg` (`theme.css` maps `--text-xs` … `--text-lg` onto them, overriding Tailwind's own fixed scale) |
| `elevation` (L3) | two flat-and-bordered levels: `level0` (base panel), `level1` (one step up — popover/menu/modal), each `{bg, border}` | `--elevation-0-bg`/`-border`, `--elevation-1-bg`/`-border` (Tailwind: `bg-elevation-0`/`1`) |
| `border` (L3) | beyond `palette.border`'s single divider colour: `strong` (an emphasised divider) and `focus` (the accent-coloured ring cm-theme.ts and the token/search highlights use instead of naming `--accent` directly) | `--border-strong`, `--border-focus` (Tailwind: `border-border-strong`/`-focus`) |
| `syntax` (L3) | the syntax palette shared by the source pane (`ui/src/listing/cm-theme.ts`) and the disasm pane (`ui/src/listing/disasm-highlight.ts`): `comment`, `keyword`, `string`, `number`, `function`, `variable`, `operator`, `invalid` | `--syn-comment` … `--syn-invalid` (Tailwind: `text-syntax-comment` …) |

`ui/src/theme/apply.ts` merges preset + overrides and writes them to `:root`
at startup (before the first React render, via `ui/src/theme/store.ts`'s
module-load side effect — see "One state, three ways to change it" below).
`ui/src/theme/theme.css` maps each runtime variable onto a Tailwind theme key
(`@theme inline`), so components write `bg-surface`, `text-sev-crit`,
`rounded-ui`, `font-mono` and never a raw value.

**Density** (`comfortable` by default — the shell must not feel cramped) is a
runtime toggle in the top bar and in the command palette. It sets the root
font-size and Tailwind's `--spacing` unit, so every rem-based type size and
every padding/gap utility rescales at once; no component has a density branch.
Both densities' `unit`/`fontSize`/`rowHeight` (`ui/themes/{dark,light}.json`)
were widened for the "feels scrunched" pass — `comfortable`'s unit moved off
Tailwind's own 0.25rem default (which made "comfortable" indistinguishable
from stock) to 0.3rem, `compact` to 0.22rem — and `ui/src/theme/theme.css`'s
`body` sets `line-height: 1.5` (>= the 1.45 floor at both densities). The
preset and density both persist to `localStorage`
(`ui/src/theme/store.ts`, keys `hbc2js.theme.preset`/
`hbc2js.theme.density`), wrapped in try/catch like every other localStorage
use in the shell.

**Art direction is a placeholder** (spec 22 §1): cool slate, `--bg #0e1520`,
`--accent #4c9be8`, IBM Plex Sans/Mono loaded from Google Fonts in
`ui/index.html` with full local fallback stacks. Fred's seed replaces the
preset values, not the structure.

### Editor theme presets (bur 3, docs/UI-BURS.md #3)

Ten presets modelled on themes common to neovim and VS Code, alongside the
shipped `dark`/`light`. Colour VALUES are not copyrightable; nobody's CSS or
source was copied — each `ui/themes/*.json` was written from scratch,
deriving hex values from the project's own published palette (a couple of
extra "surface"/"border" shades were interpolated where the source palette
does not have that many tiers — `gruvbox`, `solarized`, `dracula`, `one-dark`
namely). Attribution and upstream licence, per preset:

| Preset file(s) | Family | Upstream project | Licence |
|---|---|---|---|
| `gruvbox-dark.json` / `gruvbox-light.json` | `gruvbox` | [morhetz/gruvbox](https://github.com/morhetz/gruvbox) | MIT |
| `catppuccin-mocha.json` (dark) / `catppuccin-latte.json` (light) | `catppuccin` | [catppuccin/catppuccin](https://github.com/catppuccin/catppuccin) | MIT |
| `tokyonight.json` (dark) | `tokyonight` | [folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim) | Apache-2.0 |
| `nord.json` (dark) | `nord` | [arcticicestudio/nord](https://github.com/arcticicestudio/nord) | MIT |
| `dracula.json` (dark) | `dracula` | [dracula/dracula-theme](https://github.com/dracula/dracula-theme) | MIT |
| `one-dark.json` (dark) | `one-dark` | Atom's One Dark (e.g. [atom/atom](https://github.com/atom/atom), [one-dark.vim](https://github.com/joshdick/onedark.vim)) | MIT |
| `solarized-dark.json` / `solarized-light.json` | `solarized` | [altercation/solarized](https://github.com/altercation/solarized) | MIT |

Every file carries exactly `dark.json`'s token key set
(`tests/gate/ui/tokens.test.ts`, "every file in ui/themes/ carries exactly
dark.json's token key set") — the gate fails a new preset that is missing a
token dark.json has, or that adds one it doesn't.

### Two slots, one toggle (bur 12, docs/UI-BURS.md #12)

Bur 12 replaced bur 6's family dropdown + mode switch: a menu of every
preset (even split by family) is still "too many choices in one menu" for a
light/dark toggle. The theme's runtime state (`ui/src/theme/store.ts` — a
vanilla `useSyncExternalStore` store, the same pattern as
`ui/src/actions/store.ts`, not React state, so it has exactly one
persistence path — `localStorage`, wrapped — and can be read/changed from
OUTSIDE React) now keeps:

- **Two persisted slots**, `light` and `dark` (`hbc2js.theme.light` /
  `hbc2js.theme.dark`), each one preset name. Defaults are the shipped
  `light`/`dark` presets. Assigning a slot a preset of the wrong mode throws
  (`src/ui-core/theme-slots.ts`'s `withSlot`) — a light theme can never sit
  in the dark slot.
- **Which slot is active** (`mode`, persisted as `hbc2js.theme.mode`). The
  preset actually on screen is whichever slot `mode` names
  (`activePreset()`).

Three ways to change it, all going through the SAME store so they can never
disagree:

- **The toolbar button** (`data-testid="theme-toggle"`, top bar, replacing
  bur 3/6's preset dropdown there) — one click flips `mode`
  (`toggled()`/`toggleTheme()`). It shows "Light"/"Dark" text, never a menu.
- **The `view.themeToggle` keymap action** (bur 6, still bound in every
  preset — `Ctrl-Shift-L` in `default`) — the same flip.
- **`:set theme <preset>`** (bur 5, command mode) — names a preset directly,
  e.g. `:set theme dracula`; this fills that preset's OWN slot (by its
  `mode`) and makes it active in one step (`withPresetActive`), so naming a
  preset still both configures and shows it immediately.

**Settings → Theme** (bur 12) is now the ONLY place the full preset list
appears — split into two selects, "Light theme" and "Dark theme"
(`data-testid="theme-light-select"`/`"theme-dark-select"`), each listing
only `ui/src/theme/apply.ts`'s `presetsOfMode("light"|"dark")`. Picking a
preset here fills that slot; it does not change which slot is active (only
the toggle does that) — so editing the dark slot while looking at the light
theme takes effect the next time you toggle to dark.

The slot-selection logic (`withSlot`/`withPresetActive`/`toggled`/
`activePreset`) lives in `src/ui-core/theme-slots.ts`, dependency-free (no
DOM, no `import.meta.glob`), so it is unit tested under plain `node --test`
(`tests/ui-core/theme-slots.test.ts`) the same way `keymap-resolve.ts` is;
`ui/src/theme/store.ts` is the thin DOM-facing wrapper (persistence + CSS
application via `applyTheme`/`resolveTheme`), exercised end to end by
`ui/e2e/theme.spec.ts`.

`ThemeProvider.tsx` is a thin React view over the store
(`useSyncExternalStore`); `main.tsx` no longer applies a hardcoded default at
startup — the store's own module-load side effect applies the PERSISTED
theme before React renders, so there is nothing left for `main.tsx` to do
(applying a second, hardcoded default there used to be needed only because
the old `ThemeProvider` corrected it later, in a post-mount effect; doing
both now would make every load flash back to the shipped default, which is
exactly what regressed and was fixed while landing bur 6).

### The token lint gate

`tests/gate/ui/tokens.test.ts` (node:test, no dependencies, pure file
scanning — it runs under the root `npm test` with no `ui/node_modules`
present) fails on:

- any hex colour, `rgb(`/`hsl(`/`oklch(`… call, or Tailwind literal colour
  class (`bg-slate-900`, `text-red-500`, `border-white`) in
  `ui/src/**/*.{ts,tsx,css}` or `ui/index.html`, **outside** the token layer
  `ui/src/theme/**` (and `ui/themes/*.json`, which is where colours live);
- a token present in `dark.json` but not `light.json` or vice versa;
- any `ui/themes/*.json` file whose token key set differs from `dark.json`'s
  (bur 3 — every new editor preset must carry every token the shipped ones
  do, no more, no less);
- a preset with no `mode` of `"dark"`/`"light"`, or no `family` (bur 6);
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

### Selection is a token, not a caret (burs 2, 7)

The listing is a **viewer**, and it says so: `EditorState.readOnly` +
`EditorView.editable(false)` were always set, but `drawSelection()` still
painted a blinking `|` the moment the content took focus, which invites
typing into a pane nothing can be typed into. `drawSelection` is gone,
`.cm-cursor`/`.cm-dropCursor` are `display: none` and `.cm-content`'s
caret-colour is transparent (`ui/src/listing/cm-theme.ts`). Text is still
selectable and copyable through the browser's own selection, and the vim
preset's block cursor (`.cm-fat-cursor`) is deliberately untouched.

The unit of selection is a **token**, the way it is in Ghidra/IDA:

- **One click** resolves the whole word under the pointer, wherever in the
  word you clicked. Word boundaries come from the document text
  (`[A-Za-z0-9_$]`, so `$foo` and `_fn75` stay one token — CodeMirror's own
  categoriser splits on `$`); the *kind* comes from the syntax tree
  (`VariableName`, `PropertyName`, `String`, `Number`, …) and falls back to
  `classifyWord` for the plain-text disasm block and for text the
  incremental parser has not reached. `ui/src/listing/token.ts` owns the
  vocabulary — `identifier | definition | property | keyword | string |
  number | comment | punctuation` — and is CodeMirror-free.
- The clicked token and **every other occurrence of it** are decorated
  (`.hbc-token-selected` / `.hbc-token-occurrence`); the occurrence scan is
  skipped above 400 kB of document.
- The token is exposed on the code-view host as `data-selected-token`,
  `data-selected-token-kind` and `data-selected-line` — the contract
  `ui/e2e/code-pane.spec.ts` asserts.
- **One click produces exactly ONE selection.** A name-like token gives
  `{kind:"identifier", name, fn, moduleId, line}`; otherwise the function
  whose marked range the line falls in; otherwise the module. The pane used
  to `select()` twice per click (line, then word), which filled the jump
  list with pairs and — when nothing was selected yet, or the line belonged
  to no function — set `fn` to a sentinel that no longer named anything.
  That is the **blank listing** bur 7 reported: the identifier selection
  dropped the module context, the file view was replaced by a per-function
  listing for a function that did not exist, and the pane rendered empty.
  An `identifier`/`string` selection now carries its `moduleId`, and it
  carries `fn` only when a real function encloses the line.

**Double-click activates the token** — "go to what this names" — and never
navigates blindly (bur 7). It is refused outright for anything that is not
name-like (the keyword `function`, a literal, punctuation) and for a name
that resolves to nothing; the header flashes `no target: <token>` and the
selection does not move. Resolution order, cheapest first:

1. the name printed at a function's own header line (the file view already
   knows every function's range, so `function factory(…)` resolves without
   a request — parameters on the same line do not);
2. `_fn<n>`, the emitter's name for a nested closure
   (`src/emit/index.ts` §6 "Function nesting"): `n` *is* the function
   index, so a call site like `r1 = _fn75;` is a real target;
3. a function this module declares under that name;
4. an exact name match from `GET /api/search/functions`, fetched **on
   demand** through the query client — the pane never pulls the whole
   function catalogue just to be ready for a double-click.

**Edit mode.** There is none in the listing itself, by design (D30): the
only writes the UI has are `annotate.rename` (F2 / vim `cr`) and
`annotate.comment`, and both already own a dialog that shows the exact
target and its reference count before commit. `validateIdentifierName()` in
`ui/src/listing/token.ts` is the syntax check bur 2 asked for (JS identifier
syntax, not a reserved word, not `undefined`/`arguments`/…), ready for that
dialog and for any future inline editor. Nothing else in the pane accepts
text. Not yet built, and not needed by either bur: an inline editor drawn
over the identifier — arrow-key motion from token to token landed as bur 13,
below.

### Arrow-key navigation (bur 13)

Up/Down/Left/Right move the listing's selection the way the mouse does,
in every preset (default, vim, ghidra) — not only vim's own `j`/`k`
motions, which are a `@replit/codemirror-vim` layer entirely outside this
registry. Four actions in `src/ui-core/actions.ts` (`listing.lineDown`,
`listing.lineUp`, `listing.tokenLeft`, `listing.tokenRight`), gated exactly
like `view.fold`/`view.unfold` (a module, or any selection carrying an
`fn`), bound to bare `Down`/`Up`/`Left`/`Right` in all three shipped
presets (`src/ui-core/presets/*.json`):

- **Down/Up** step to the next/previous line, keeping the same column
  where possible;
- **Left/Right** step to the previous/next token ON THE CURRENT LINE (no
  wrap to the next/previous line).

`ui/src/listing/listing-nav-store.ts` holds the live handle — same
module-level-store shape as `./fold-store.ts` — that `CodeView.tsx`
registers (`registerFold` prop, so only the primary listing block, never
the disasm block). The move itself resolves through `hitAtPos`, the same
document-position-to-token resolver a mouse click uses (`pointerHit` in
`CodeView.tsx` now delegates to it), so a keyboard move finds exactly the
token a click at that spot would have found — same word boundaries, same
syntax-tree `kind` lookup — and reports it through the SAME
`onSelectToken` callback a click uses. That is what makes "scrolls into
view" and "the graph follow toggle tracks it" come for free: the callback
calls `select()` on the shared selection store exactly like a click did,
which is what `highlightLine`'s scroll-into-view effect and the graph
follow toggle already react to.

The "current" line/token for a keyboard move is read from the SAME
`data-selected-line`/`data-selected-token` attributes the pane already
exposes as its contract (see above) — no separate cursor state to drift
out of sync with a click. Before anything has ever been selected, a move
starts from the top of the document.

Because the shared keymap listener (`ui/src/actions/keys.ts`) already
ignores any `input`/`textarea`/`select`/contenteditable target, arrow keys
never steal from the search box, the command palette or a dialog — those
are all `<input>` elements, the same guard every other chord already
relies on.

Gate coverage: `tests/ui-core/actions.test.ts` (registration, gating,
`ActionApi` routing, chord binding in all three presets) and
`tests/gate/ui/keymap-default.test.ts` (the specific action ids every
preset's `Down`/`Up`/`Left`/`Right` must resolve to); `ui/e2e/listing-nav.
spec.ts` presses ArrowDown/ArrowUp against a real listing.

### Source↔disasm alignment

`GET /api/fn/:fn/linemap` (above) says which line of the served source came
from which instruction. `ui/src/listing/line-map.ts` turns that into the line
of the disassembly to highlight — pure functions, no React and no CodeMirror,
so the root gate imports them directly with no `ui/node_modules` present
(`tests/gate/ui/line-map-align.test.ts`):

- `fnLocalLine` rebases the editor's line onto the function's own numbering
  (the centre pane usually shows the WHOLE module file, so it subtracts
  `fnStartLine`); `null` above the function's first line or with no range;
- `rowForLine` takes the exact row for that line, else the nearest mapped line
  **above** it — the last instruction known to precede the cursor. Rows whose
  `fn` is not the selected function (a nested closure's) are ignored: their
  offsets index a different listing;
- `disasmLineForOffset` finds the line by its `[@ <offset>]` prefix, which is
  exactly what `src/disasm/print.ts` writes.

**Following the cursor into a nested closure.** After §16.2's inline-function
mapping landed, a function's linemap also carries rows for statements printed
inside an inline function expression, whose `fn` is that CHILD closure's own
Hermes index — `rowForLine` above ignores them (correct for the plain "which
line in THIS listing" question it answers). `rowForLineAcrossFns` answers the
different question `CenterPane.tsx` actually needs when the cursor might be
sitting inside a printed-inline closure: the nearest preceding row in the
WHOLE array, whichever `fn` it belongs to. When that `fn` differs from the
one asked about, the result carries `nested: true` and the child's own `fn` —
the honest disassembly to show is the CHILD's, not the parent's nearest
preceding line. `CenterPane` then fetches that child's own `/api/fn/:fn/disasm`
(`useDisasm`, an unconditional hook call keyed on the resolved child or -1)
and renders it with a small header ("fn N — nested closure inside fn M")
whose click jumps straight to the child (the same `select({kind:"fn", fn})`
path a Callees row uses). No flicker: the pane keeps its previously rendered
disasm (parent's or a previously-visited child's) until the newly resolved
target's own data has actually loaded, so moving the cursor in and out of a
closure never blanks the pane mid-fetch. A genuine function switch (a
different top-level `fnId`, e.g. an xref jump) still clears it, so THAT
transition keeps its own honest loading/error state.

One known imprecision (§16.2): an inline closure's closing `}` / `);` line
shares the enclosing statement's own line (neither carries an origin), so the
LAST printed line of a nested closure's body can still resolve to the CHILD
even though a human reads that line as back in the parent — accepted rather
than guessed around, and pinned by a test
(`tests/gate/ui/line-map-align.test.ts`) as documented behaviour. This is a UI
default Fred may change; it is not a claim about what the bytecode did, only
about which listing is more honest to show while the imprecision is
unresolved.

`CenterPane.tsx` feeds the result to the disasm `CodeView` as its
`highlightLine`, so the existing `hbc-selected-line` decoration and its
scroll-into-view are reused — no new theme token, no new CodeMirror extension.
`null` (nothing honest to point at: an unmapped line near the top of a
function, an empty map, a truncated listing) leaves the disassembly pane
exactly where it was, and the alignment never opens or closes the fold.

Coverage is **partial by design** and the emitter side (`docs/specs/05-
emitter.md` §16) owns the ratchet: about 64% of non-blank rendered lines on
`rn-template-0.72` today. Closing braces, hoisted `let` blocks, helper
preludes, generator scaffolding and anything a stage-B pass synthesised carry
no origin, and the map says nothing about them rather than guessing.

`ui/src/mock.ts`'s `DISASM` uses the real `[@ N] Opcode …` shape (its opcodes
are still obviously fake) because the alignment finds its line by that prefix;
a mock in another format would make the feature untestable in mock mode. A gate
test asserts the shape so it cannot drift back.

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

**The screens hierarchy and its navigation arrows (spec 26 L4).** Inside the
**Screens** and **Navigation** groups the rows are no longer a flat list: they
are ordered as a tree, a sub-screen indented under the screen (or navigator)
that owns it, from `GET /api/screens`. Opening a screen row also reveals its
**navigation arrows** — one `-> TargetScreen` row per `navigatesTo` edge,
labelled `resolved` when the points-to index proved the call and `by-name`
(italic, dashed marker) when it is only a route-name match, the same
convention the Xrefs pane uses for `who-calls-by-name` candidates and the
graph pane for its dashed edges. Clicking an arrow opens the target screen in
the centre pane and opens its row, so following a flow is one click per hop.
The projection is pure and gate-tested (`ui/src/listing/screens.ts`,
`tests/gate/ui/screens-model.test.ts`): a module is rendered at most once and
never under itself even if the wire says otherwise, and an edge naming a
module that is not itself a screen row is dropped rather than drawn as a stub
the analyst cannot open. `ui/src/graph/model.ts`'s `buildScreensModel` draws
the same edges in the graph pane, reusing the module-node renderer (a screen
IS a module) with by-name edges dashed. When `/api/screens` is unavailable
(404, mock adapter, or a server without the route) the groups stay exactly the
flat list they were — the tree is never blank because this route is missing.

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
lot of requests to fill a tree that shows a dozen rows. The per-function
editor renders at most `MAX_RENDER_LINES` (5,000) lines and says how many it
hid (`ui/src/listing/truncate.ts`), on top of the server's own truncation;
the whole-module file view uses the much higher `MAX_RENDER_LINES_MODULE`
(200,000) instead — see "What is stubbed" below for why. The
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

- ~~**Source↔disasm alignment**~~ FIXED: clicking a source line highlights and
  scrolls the disassembly to the instruction that produced it (see
  "Source↔disasm alignment" below).
- ~~The command palette lists hard-coded items~~ FIXED: `CommandPalette.tsx`
  builds its list from `paletteItems(ctx, registry)` (see "Actions, keymap,
  context menu, annotate" below) — every registry action is reachable by
  `Cmd/Ctrl-K`, not just the theme and density toggles.
- ~~The context menu items are disabled; rename/comment is landing 5~~ FIXED:
  the context menu is built from the same action registry as the palette and
  rename/comment/tag write through `McpTools` (see "Actions, keymap, context
  menu, annotate" below).
- **The activity pane** is live (see "Activity feed" below) — this bullet
  is now historical.
- ~~No virtualisation~~ FIXED: the tree is windowed by
  `@tanstack/react-virtual` (see "Virtualised" above). ~~The editor is
  capped at 5,000 rendered lines~~ FIXED for the module (whole-file) view:
  Fred's instruction was "file view must show the whole module", and
  CodeMirror 6 turned out to already virtualise the viewport on its own
  (only the `.cm-line`s actually on screen are ever mounted, independent of
  document length) — measured on the fixture project's `module_226`
  (29,754 lines) via `ui/e2e/`'s throwaway rig (never the live NSW ports):
  DOM nodes under `.cm-content` 751 → 750, `.cm-line` count 36 → 36, paint
  ~399ms → ~373ms, i.e. no measurable cost from lifting the cap. So
  `ui/src/listing/truncate.ts`'s `MAX_RENDER_LINES` (5,000, per-*function*
  editor, e.g. "Show raw Hermes") is unchanged, but the module/file view now
  uses `MAX_RENDER_LINES_MODULE` (200,000) — a safety ceiling for a
  pathological generated file, not a rendering target — with the same
  honest truncation bar beyond that. No graph view, no worker/jobs rail
  bullet applies here (the AI tab landed separately, see "AI workers"
  below); no further Playwright smoke gaps known.
- **Strings & globals xref** landed (see "Strings & globals (xref)" below):
  a Strings tab in the right pane searches the string table and global
  reads, and jumps to a use. Both routes now inline the using function's
  name/size server-side (no more client-side catalogue workaround).
- **Tables (object literals)** landed (see "Tables (object literals)"
  below): a Tables tab lists spec 17 §14.2's bundle-wide constant
  object-literal inventory, filterable by key/value regex, min-props and
  string-ratio, and jumps to the owning function.

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

### Keyboard shortcuts, and why none of them used to fire

The owner reported on 2026-09-05 that "none of the key bindings work"
(docs/BUGS.md, `review-2026-09-05-keys`). Two independent faults, both in the
normalisation between a browser `KeyboardEvent` and a chord string:

1. **Case.** `src/ui-core/keymap.ts` hashed a chord step and a live event
   into the same trie key, but case-sensitively for single characters. A
   browser reports `key: "p"` for Ctrl+P while the preset writes `"Ctrl-P"`,
   so `Ctrl-P` (palette) and `Ctrl-F` (search) — the two chords anyone
   actually presses — could never match. `stepMapKey` now lower-cases a
   single character that carries Ctrl/Alt/Meta, keeps Shift significant for
   letters (`Ctrl-N` and `Ctrl-Shift-N` stay different chords) and ignores it
   for punctuation and digits, whose shift state is layout dependent. A BARE
   character step is untouched: vim's `K` is still not `k`.
2. **Modifier.** Every preset writes `Ctrl-`, the top bar advertises
   "Cmd/Ctrl-K", and the owner is on a Mac, where nobody presses Control.
   `ui/src/actions/keys.ts` now folds a lone COMMAND into `ctrl` on macOS
   (`isMacPlatform`), so the whole keymap is reachable with the key Mac users
   actually use. No preset binds a `Meta-` chord, so nothing is shadowed, and
   an unbound Command chord still resolves to "none" and is left to the
   browser (Cmd-R, Cmd-T, Cmd-C are untouched).

`Ctrl-K` is now a real binding for `project.palette` (it was only ever a
hard-coded `useEffect` inside `CommandPalette`, which the preset chord then
raced; that listener is gone). Two new actions ship with it: `?` opens the
**Keyboard shortcuts** cheat-sheet (`ui/src/components/KeymapHelp.tsx`) and
`Ctrl-,` opens **Settings**. Both are also palette entries, both have a top
bar affordance, and the cheat-sheet renders `activeBindings()` joined against
the registry — it is a view over the live keymap, never a second list.

Regression tests: `tests/gate/ui/keymap-default.test.ts` presses the real
browser event for every chord in every shipped preset;
`tests/ui-core/keymap-bindings.test.ts` covers the normalisation and the
binding algebra; `ui/e2e/keys.spec.ts` drives the chords through Chromium,
including with focus inside CodeMirror.

### `/` search, `:` command mode, `theme.toggle` (burs 4/5/6)

**`/` opens search** (bur 4, docs/UI-BURS.md #4). Every shipped preset binds
`/` to `project.search` (vim already had it; `default` and `ghidra` gained
it). The action (`ActionApi.search`) focuses and selects the function search
box (`input[aria-label="search functions"]`) exactly like `Ctrl-F` always
did — `/` is simply another chord on the same action, so there is only one
code path to keep working. `tests/gate/ui/keymap-default.test.ts` asserts
every preset's `/` binding; `ui/e2e/keys.spec.ts` presses a bare `/` with
focus inside CodeMirror and checks the search box gets focus.

**`:` opens the command palette in command mode** (bur 5, docs/UI-BURS.md
#5). Every preset binds `:` to a new action, `project.commandMode`
(`ActionApi.openCommandMode`), which opens the SAME `CommandPalette`
component the `Ctrl-K`/`Ctrl-P` chords do, but tags the open with
`paletteMode: "command"` (`ui/src/actions/store.ts`) so `CommandPalette.tsx`
prefills its query with `":"` instead of leaving it blank. No new component,
per the brief — the palette already had one item list and one input; command
mode is a second interpretation of that same input's value.

While the query starts with `":"`, `src/ui-core/commands.ts` (a pure,
node-testable parser — no DOM, no registry) turns it into one of:

| Query | Effect |
|---|---|
| `:<action-id>` | fuzzy-matched (`fuzzyMatchIds`, case-insensitive subsequence) against every registered action id; the palette shows the filtered list and Enter runs the selected one |
| `:fn <n>` | opens function `n` |
| `:mod <id>` | opens the first function in module `id` |
| `:goto <name>` | opens the first function whose name contains `<name>` (case-insensitive) |
| `:q` | closes the active dialog, else the active overlay, else resets the right panel |
| `:set theme <preset>` | switches the theme preset |
| `:set keymap <preset>` | switches the keymap preset |

`ui/src/actions/registry.ts`'s `runCommand(query)` executes a parsed
command — it is the one place with the query client, the theme store and the
keymap store all in scope, so `commands.ts` stays a pure parser and
`CommandPalette.tsx` stays a thin view: while a verb is recognised it renders
one synthetic row (`describeCommand`) that Enter runs; otherwise it disables
cmdk's own filtering (`shouldFilter`) and renders the action list filtered by
`fuzzyMatchIds` itself. `tests/ui-core/commands.test.ts` covers the parser
and the fuzzy matcher; `ui/e2e/keys.spec.ts` drives `:` → `:fn 74` end to end
against the e2e fixture (`rn-template-0.72`, which has an fn 74).

**`view.themeToggle`** (bur 6, docs/UI-BURS.md #6; slot semantics rewritten
by bur 12, docs/UI-BURS.md #12) flips the active slot — see "Two slots, one
toggle" above — bound in every preset so switching modes never requires
opening Settings:

| Preset | Chord |
|---|---|
| `default` | `Ctrl-Shift-L` |
| `ghidra` | `Ctrl-Alt-L` |
| `vim` | `<leader>t` |

`tests/gate/ui/keymap-default.test.ts` asserts every preset binds a chord to
`view.themeToggle`; `ui/e2e/theme.spec.ts` drives the toolbar button and this
chord, checks `--bg` changes and persists across a reload, and checks
Settings assigning a different preset to a slot changes what the toggle
shows.

### Settings dialog

`ui/src/components/SettingsDialog.tsx` (`project.settings`, `Ctrl-,`, gear in
the top bar) is the in-app config the shell was missing — the layout is
untouched, art direction stays Fred's. Two tabs:

- **appearance** — bur 12's two mode-filtered selects, "Light theme"
  (`data-testid="theme-light-select"`, `ui/src/theme/apply.ts`'s
  `presetsOfMode("light")`) and "Dark theme"
  (`data-testid="theme-dark-select"`, `presetsOfMode("dark")`) — the ONLY
  place the full preset list appears, and even there split by mode so
  neither select can offer a mismatched preset; density
  (`comfortable`/`compact`) and keymap preset (`default`/`vim`/`ghidra`),
  each applied live through `ui/src/theme/store.ts` / the live keymap and
  persisted to `localStorage` the same wrapped way; plus a READ-ONLY view of
  `ui/theme.json`'s resolved token overrides (tokens are edited in the file,
  not in the app — the token lint gate is what keeps them honest).
- **key bindings** — one row per registry action: its title, its live chord,
  `Record` (press the chord; Escape cancels, Backspace unbinds), a per-row
  `reset` and a `reset all to preset`. A recorded chord that collides is
  reported inline with `swap` (the other action inherits this one's previous
  chord), `replace` and `cancel` — the collision rule is
  `createKeymap`'s own (equal, prefix or extension), computed BEFORE the
  keymap is rebuilt so a bad chord can never take the shell down.

The editor writes the SAME `overrides` map `ui/keymap.json` has, layered by
the SAME resolver (`src/ui-core/keymap-resolve.ts`'s `mergeBindings` /
`chordConflicts` / `rebind` / `unbindAction` / `resetAction`, unit-tested in
`tests/ui-core/keymap-bindings.test.ts`); `ui/src/actions/registry.ts` holds
the live config (`hbc2js.keymap.preset` / `hbc2js.keymap.overrides`) and
rebuilds the keymap in place, so the cheat-sheet, the palette's chord column,
the context menu and the running listener all re-read one source with no
reload. `keymap` stays a stable proxy object, because four panes import it
directly and a rebind must not leave them holding a dead keymap.

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
subtitle says why — and so does a fn whose `GET /api/fn/{fn}/locals` 400s (no
`--hbc`, spec 17's live-verb constraint): the dialog waits for that request to
SETTLE (`locals.isPending`, not `locals.data === undefined` — a bug that once
left the dialog stuck "pending" forever and unable to submit, since an errored
query never gets `data`), then falls back the same way. Any submit failure —
no target, a server refusal — renders as an `ErrorNote` inside the dialog
itself, never only as the one-line status toast, so a failed rename is never
silent. After the write, `invalidateFn` refetches `source`, `context` and
`locals`, so the new name is on screen immediately.

Server side, the accepted `reg:F:R` names live in the project DB's `d_names`
(the same slot every `set_name` writes). `ProjectService` injects a lookup into
`ArtifactService` (`setActiveNames`), and `source(fn)` then serves
`renderFn(fn)` — ONE function re-emitted through
`src/name-overlay/render.ts`'s `renderFrame`, memoised per function and
invalidated on write — instead of the file on disk. The name is applied as the
same guarded frame-local alpha-rename `var-naming` uses, so renaming can never
change what the code does, and it stops at function boundaries: an inner
function's own `r3` is a different binding and is left alone.

**Whole-module file view honours renames too.** `GET /api/module/{id}/source`
(`src/ui-server/list.ts`'s `moduleSource`) splices every owned function that
has an accepted `reg:F:R` name with `ArtifactService.renderFn(fn)`'s re-emit
— the same text `/api/fn/{fn}/source` serves — indented to the original
range's own leading whitespace, and every `functions[].lines` tuple after the
splice point is remapped by the line-count delta so click-to-select and
scroll-to-range (`ui/src/panes/CenterPane.tsx`) stay correct. A module with no
accepted names anywhere returns the on-disk text byte-for-byte (no re-render
cost); the response's own `renderedFns` lists which owned fns were spliced.
The result is cached per module and invalidated on the next `set_name` inside
it (`invalidateModuleSourceCache`, hooked next to `renderFn`'s own
`invalidateRender`); the UI's `invalidateFn` (`ui/src/actions/registry.ts`)
drops the same module's `["module-source", id]` query key after a rename so
the file view refetches. The per-function re-render uses this build's live
decompile defaults, and stage-B passes only when the manifest recorded some
(`src/split/index.ts` runs none unless `--passes` was given), so a spliced
function can differ cosmetically from the rest of the on-disk file — this was
already true of `/api/fn/{fn}/source` and is unchanged here.

**Still rough here.** String targets (`sid:N`) are not wired — renaming a
string literal is a contract change, not a binding rename, and has no store.
`list`'s `rendered` column is exact for a named register and best-effort for a
var-named one (it classifies the same raw frame body `var-naming` classifies).
`view.fold` / `view.unfold` fold-all/unfold-all the current listing editor
(CodeMirror's `foldAll`/`unfoldAll` over `@codemirror/language`'s fold
gutter, `ui/src/listing/fold-store.ts`; `when` requires a fn or module
selected) and `view.rawHermes` expands and focuses the centre pane's Disasm
panel (`ui/src/panes/disasm-store.ts`).
The Package panel reads the real `GET /api/package-id/{mod}` (wave 4a).
`view.copyDisasmOffset` copies a real byte offset now, `fn:<n>@0x<hex>` —
`FnSummary.offset` (`src/artifact/service.ts`) is `FunctionRow.offset`
(§2.1), the function header's offset into the `.hbc` file, already recorded
by every build path; `@ui-core/disasm-offset.ts`'s `formatDisasmOffset` does
the formatting and falls back to the old `fn:<n>` shape if no offset is
known yet (mock mode fabricates a deterministic `fn * 64`, not a real one).

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

**Live update: the in-process write bus + shard-addressed delta apply
(spec 26 L1, spec 21 §1.2/§1.3).** Before this landing, `useLog` fed every
row to the Activity pane only — an agent's rename reached the feed and
nowhere else. Two additive changes close that gap:

- *The doorbell.* `src/ui-server/server.ts` keeps one in-process
  `EventEmitter` per server instance. Right after a request to a route in
  `routes.ts`'s `WRITE_TOOL_PATHS` lands (status 200), the handler emits
  `"wrote"`; every open `/api/events` connection's poll-tick check function
  is also registered on that event, so it re-checks the log immediately
  instead of waiting for the next `SSE_POLL_MS` (500 ms) tick. The tick
  itself never stops — it is the fallback for a missed/coalesced doorbell
  and the only path when nothing in-process ever emits (a second process
  writing the same log, or a hand edit adopted via `hbcproj adopt`). The log
  stays the authority throughout; the bus is only ever a latency
  optimisation over it (spec 21 §1.3).
- *Shard-addressed delta apply.* `src/projdb/revision-store.ts`'s
  `appendLog` now writes `{kind, target}` (not just `{kind}`) into each
  `log` row's `detail` — `target` is the write's own `fn:N`/`mod:N`
  binding-id. `tailLog` (`src/ui-server/routes.ts`) parses this back out
  into an ADDITIVE `targets: string[]` field on both `LogTail` (`/api/log/
  tail`'s JSON body) and the SSE `log` frame — a coarse, batch-level hint;
  old clients that only know `rows`/`cursor` are unaffected. The precise
  per-row mapping lives in `ui/src/state/log-delta.ts`'s pure
  `applyLogDelta(entry) -> readonly string[]`, which `useLog`'s `append()`
  runs over every fresh row (SSE or poll, same code path) and turns into
  `queryClient.invalidateQueries` calls (`ui/src/hooks.ts`) — so a `name`
  write on `fn:12` invalidates exactly `["context",12]`/`["fn",12]`/
  `["who-calls-by-name",12]`, a `finding`/`status` write also invalidates
  `["findings"]`, and a row whose target does not parse (an `op:'init'`
  row, or one minted before this landing) invalidates NOTHING — never a
  blanket refetch, which would defeat the whole point. This runs over the
  full fresh-row list before `LOG_FEED_MAX_ROWS` trims the DISPLAY array, so
  a burst larger than that window still invalidates every pane it touched.
  The net effect: a rename made from anywhere — another browser tab, an
  agent calling `McpTools` directly, a hand edit — now reaches the pane
  showing that fn, not only the Activity feed.

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

## Xrefs

The right pane's **Xrefs** tab (`ui/src/panes/RightPane.tsx`) shows the
selected function's resolved neighbours: `called by` (`GET /api/fn/:fn/
callers`, `useWhoCalls`) and `calls` (`GET /api/fn/:fn/callees`,
`useCallsFrom`), each row an `XrefRow` that jumps to that function via
`select({kind:"fn", fn})` — the same navigation call the Strings tab's use
rows and the module tree's function rows already use, so jump-list
back/forward picks it up for free.

**Callers by name (heuristic).** `who-calls` is `total:0` for the dominant
RN dispatch idiom (`const m = require(list[N]); m.export(...)`) — the callee
register is list-indexed, so the calls index records `?`. Below the exact
callers, a second, clearly-labelled "Callers by name (heuristic)" section
shows `GET /api/xref/who-calls-by-name?fn=` (spec 17 §14.1, `useWhoCallsByName`):
every function that reads a property under one of the selected function's
export names, excluding its own module. **These rows are candidates, not
proven callers** — `confidence: "by-name"` is a NAME match on a
`property-get`, never a resolved call edge (three known false-positive
classes: an unrelated same-named method, a re-export/barrel, or two modules
exporting the same name — spec 17 §14.1's "known false-positive classes").
The section:

- is fetched **lazily**, only while the Xrefs tab is the visible right-panel
  tab for the selected fn (`enabled: hasFn && panel === "xrefs"` on the
  hook) — no reason to pay for the scan while another tab is showing;
- renders each row (`ByNameRow`) in the muted theme token
  (`text-text-muted`, not a new colour) so it visibly reads as
  lower-confidence than an exact `XrefRow`'s `text-text`; a row jumps to its
  function exactly like an exact-caller row;
- when the server marks the export name **ambiguous** (`names[].ambiguous`
  — a common JS member like `default`/`map`/`then`, or over the 200-function
  fan-out limit), renders the `why` as a one-line explanation instead of
  drawing rows (an ambiguous name always contributes zero candidates by
  design, per spec 17 §14.1 — dumping the fan-out would be noise);
- is **hidden** when the exact callers are already non-empty and the
  by-name scan found nothing — a well-resolved function does not grow a
  pointless extra section.

## Strings & globals (xref)

Spec 22 §3's "xref panels … strings/globals": a **Strings** tab in the right
pane (`ui/src/panes/RightPane.tsx`, `ui/src/panes/StringsPane.tsx`), next to
Xrefs — not the bottom pane. The bottom pane is the activity/log feed (one
kind of content, a live append-only stream); a string/global search is a
query surface like Xrefs and Context, and it needs the same jump-to-function
navigation those already have, so it lives where they live rather than
introducing a second navigation surface in a different part of the layout.

**Strings.** A search box (`aria-label="search strings"`,
`data-testid="search-strings"`) with a substring/regex mode toggle
(substring default), debounced 250ms (`useDebouncedValue`, `ui/src/hooks.ts`)
against `GET /api/xref/string?mode=substring|regex&key=` (`useStringGrep`).
Each result row (`sid · head · uses`, `data-sid` on the row) is honest about
the API's cap: a `"N of TOTAL rows (truncated)"` line, same pattern the
Xrefs tab uses for `callers`/`callees`. Clicking a row expands it in place —
`mode=exact` (`useStringUses`) lists its uses (function, role, count); a use
row (`data-fn` on the row, same attribute the module tree puts on every
function row) jumps to that function via `select({kind:"fn", fn})`
(`ui/src/state/selection.ts`), the same navigation call `RightPane.tsx`'s
`XrefRow` already uses — the jump list (back/forward) picks it up for free,
no separate "navigation action" needed beyond calling `select`.

**Globals.** A second, smaller search under the same tab: a global's name
against `GET /api/xref/global?name=` (`useGlobalUses`), same row/jump
treatment, plus `file:line` (the owning function's range — spec 17 §1/§14:
site-level global positions are not materialised).

**Reachable everywhere.** `navigate.strings` ("Find string uses…") is an
ordinary `src/ui-core/actions.ts` registry action — palette, context menu (on
a `"string"`-kind selection, e.g. a clicked string literal, which pre-fills
the search via `ui/src/panes/strings-store.ts`) and a chord in all three
keymap presets (`Ctrl-Shift-S` default, `gs` vim, `Ctrl-Alt-S` ghidra).

**API gap — closed.** `StringUseSite` (`xref/string` mode=exact's `uses`
rows) and `GlobalUse` (`xref/global`'s rows) now carry `name`/`size` too,
inlined server-side (`McpResources.xrefString`/`globalUses`, `src/mcp/
resources.ts`) via the same `neighbor()` helper `inlineEdges` uses for
`who-calls`/`calls-from` — additive fields only, `fn`/`role`/`n` (and
`access`/`file`/`line` on the global row) unchanged, the Bounded cap
unchanged. `StringsPane.tsx` now renders the server-inlined `name` directly
(`fn:<n>` only as the last resort, when the server itself has no name for
that fn — e.g. a native/unknown neighbour); the client-side catalogue-lookup
workaround (`useFnName`) is gone.

## Tables (object literals)

Spec 17 §14.2's bundle-wide constant object-literal inventory ("endpoint
tables"), surfaced as a **Tables** tab in the right pane
(`ui/src/panes/RightPane.tsx`, `ui/src/panes/TablesPane.tsx`), right after
Strings — same reasoning as "Strings & globals (xref)" above: a query
surface that jumps to a function belongs where the other query surfaces
live.

**Filter bar.** Key regex, value regex, min-props number, string-ratio
number (all optional, debounced 250ms like the Strings search), and a
"paths only" preset button that sets the value filter to
`^(/|https?:)` — the exact filter spec 17 §14.2's Service NSW example uses
to surface both endpoint tables in one query. Unlike Strings, the tab is
**not** gated on typing something first: with every field blank the
server's own defaults (>=4 members, >=50% string-valued — "the shape of a
table, as opposed to an options bag") already answer a useful inventory, so
`useObjectTables` (`ui/src/hooks.ts`) fetches on mount against
`GET /api/object-tables?minProps=&stringRatio=&key=&value=&minMatched=&module=&limit=`
(`ui/src/api.ts`'s `ObjectTablesQuery`; `minMatched` — server default 1 —
is not its own filter-bar field, just passed through for forward
compatibility).

**Result list.** Sorted exactly as the server ranks (`ArtifactService.
objectTables`'s `compareObjectTables`): unfiltered, biggest table first;
FILTERED (a `key`/`value` given), `matched` — how many members the query
actually hit — first, then hit density, then size, so a 2,125-member
HTML-entity table with one accidental hit no longer outranks a real
41-member endpoint table. Each row shows
`fn <n> <fnName> · module <m> · K members (S strings)`, plus
`· M matched` whenever `matched` (`ObjectTable.matched`,
`ui/src/contracts.ts`) is less than the member count — i.e. only once a
filter actually narrowed the hit, never on an unfiltered row where it would
just repeat the count already printed — and a
`"N of TOTAL tables (truncated)"` line honest about the server's cap, with
the scanned/failed function counts alongside it. Clicking a row both
selects that function — `select({kind:"fn", fn})`
(`ui/src/state/selection.ts`), the SAME navigation call `XrefRow` and the
Strings tab's use rows already make, so the jump list picks it up for free
— and expands the row in place to its members, capped at 40 with a
"+n more" line. A string member renders its value; every other kind
(`computed`, `number`, `boolean`, `null`, `undefined`, `unknown`) renders
`<kind>` in the muted theme token, since the server itself only recovers
the true value for string-kind members (`ObjectTableMember`,
`ui/src/contracts.ts`) — a computed member's value would need the
decompiler, and this verb deliberately never runs one (spec 17 §14.2).

**Reachable everywhere.** `navigate.tables` ("Find object tables…") is an
ordinary `src/ui-core/actions.ts` registry action — palette, context menu
(on a `"string"`-kind selection, e.g. a clicked string literal, which
pre-fills the value filter via `ui/src/panes/tables-store.ts`, same pattern
as `strings-store.ts`) and a chord in all three keymap presets
(`Ctrl-Shift-T` default, `gt` vim, `Ctrl-Alt-T` ghidra).

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

## Graph view

The **Graph** tab in the right-hand panel (spec 25, decision D28) draws the
*neighbourhood* of whatever is selected — never the whole graph. Renderer:
React Flow (`@xyflow/react`, MIT); layout: `@dagrejs/dagre` (MIT), top-down
layered, callers above the focus and callees below. Code lives in
`ui/src/graph/` (`model.ts` pure, `layout.ts` pure, `nodes.tsx`, `store.ts`,
`GraphPane.tsx`); `graph.css` re-points React Flow's own chrome at the theme
tokens, so the graph has no palette of its own.

Two modes, chosen by the selection:

- **Call neighbourhood** of a function — `GET /api/fn/{fn}/callers`,
  `/api/fn/{fn}/callees`, and `GET /api/xref/who-calls-by-name?fn=` drawn as
  **dashed, muted** edges (candidates, never proven callers — the same honesty
  rule the Xrefs pane follows). Neighbours with no function index (`require`
  module refs, `computed-callee` unknowns) are drawn as `ext:` nodes and are
  not navigable.
- **Module edges** of a module — `GET /api/module/{id}`'s direct `deps` and
  `dependents`. Direct edges only; spec 17 §14 cut the whole module graph.
- **CFG** is not implemented: `src/ui-server` publishes no per-function CFG
  route (spec 25 §7 keeps it as a follow-up).

Interactions: **click** a node to focus the graph on it (the breadcrumb at the
top grows; the code pane is untouched), **double-click** to select it — that
jumps the listing and re-roots the graph there. **+** on a node expands one
more hop into the existing drawing. **⛶** maximises the pane over the window
(a call neighbourhood does not read at 280 px) and back.

Scale rules, all visible in the UI:

- **Layout for the frame** (bur 11, spec 25 §5c) — the pane measures itself
  with a `ResizeObserver` and lays the neighbourhood out for that box: dagre
  still ranks the nodes (callers above, focus, callees below) and orders each
  rank, then each rank is re-packed into rows that wrap at the widest grid the
  frame holds at a legible node width (`NODE_W_MIN = 104`, preferred
  `NODE_W = 176`). `chooseGrid` picks the column count that maximises the node
  width *after* `fitView` scaling, so the 280 px docked panel gets one full-
  width column and the maximised window gets a compact grid, from one code
  path. The laid-out box is never wider than the frame. Before this the pane
  drew a rank of eight callees as one ~1600 px row and fit-to-view shrank it
  to illegibility. Without a measurement yet (first render) the layout is
  exactly the old dagre placement, reported as `columns: 0`.
- **Level of detail** — below zoom 0.55 labels come off and nodes render as
  token-coloured boxes (`data-lod="min"`).
- **Cap** — at most `GRAPH_NODE_CAP = 300` nodes; the overflow is dropped and a
  truncation bar says how many are not drawn, the same idiom as the listing's.

Actions: `graph.open`, `graph.focus`, `graph.expand`, registered in
`ui/src/actions/registry.ts` (browser shell only); `graph.followToggle`
(`g f`) and `graph.lodCycle` (`g z`) live in the SHARED registry
(`src/ui-core/actions.ts`) and are bound in all three presets, because a
preset chord must name an action every shell knows. The shared registry's
`view.graph` stays disabled — `tests/ui-core/actions.test.ts` asserts that, and
an implementation task does not invert an existing test — but its `openGraph`
binding now opens this pane, so enabling it later is a one-line change plus
that test's update.

**Drag, highlight, reset, follow** (spec 25 §5a, burs 8/10, 2026-09-05):
nodes are draggable (`nodesDraggable`); the offset is kept in
`ui/src/graph/store.ts` until either the neighbourhood changes (a new focus
clears it — it would be meaningless for nodes that are no longer drawn) or
the toolbar's **reset view** button is clicked, which drops it and re-runs
`fitView`. Hovering a node (or, with **follow** on, selecting a call site
whose callee the graph already drew) highlights it and its direct
neighbours (an `accent` ring) and dims everything else — the pure
neighbour-set computation is `neighbourSet` in `ui/src/graph/model.ts`, so
hover and follow share one mechanism. The **follow** toggle
(`data-graph-follow`, persisted in `localStorage`, **default ON**) makes the
graph track the listing selection: a different function re-focuses the
graph exactly as clicking `graph.focus` would; turning it off freezes the
graph where it is regardless of what gets selected.

**Semantic zoom** (spec 25 §5b, bur 9, 2026-09-05) — "as you zoom in you see
more". The toolbar's `lod:<level>` button (and `g z`, and a wheel/pinch zoom)
steps three levels over the SAME fetched neighbourhood; no level fetches
anything new:

- **far** — the neighbourhood folded into its **modules**, with each pair of
  modules joined by one bundled edge carrying how many function edges it
  stands for. A function whose module the contract did not report stays its
  own node rather than being guessed into someone else's; an intra-module
  edge is not drawn (it is what `mid` is for).
- **mid** — the function neighbourhood, exactly as before.
- **near** — the focus function opens into a card listing its drawn callers
  and callees (bounded, with an honest `+N more`) and the line
  `blocks: CFG pending (spec 26 L9)`. This is a **stand-in**: spec 26 L9 adds
  `GET /api/fn/{fn}/cfg` and swaps the card body for the block graph.

The level is a pure function of the viewport zoom with hysteresis
(`lodLevel(zoom, prev)`, thresholds 0.5 and 1.6, a 12% sticky band), so a
zoom resting on a boundary cannot flicker between two layouts; and only a
USER gesture moves it — React Flow's own `fitView`/Controls moves report a
null source event and are ignored, because a pane fitting itself must never
silently re-draw at another level. Going to `far` collapses the extra hops
(parking at most 8, restored on the way back); `mid`/`near` never
auto-expand anything. **Reset view** returns to the level the neighbourhood
was rooted at and re-fits at that level's nominal zoom.

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
- Ports and the throwaway root are env-overridable so two agents can run
  the suite concurrently on one box: `HBC2JS_E2E_PORT_BASE` (API port,
  default 7341; preview is base + 1) and `HBC2JS_E2E_ROOT` (default
  `$TMPDIR/hbc2js-ui-e2e`, and `$TMPDIR/hbc2js-ui-e2e-<port>` whenever the
  port base is not the default, so a second run does not fight the first
  over the same throwaway dist). `ui/e2e/playwright.config.ts` imports both
  from `prepare-fixture.mjs`, so setting the env var for `npm run e2e`
  moves the whole rig.
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

## Component/DOM tests, kitchen sink, and visual regression (spec 26 L7)

Spec 19 §2 named six test layers; L7 landed the two that were missing,
layers 2 and 4.

**Layer 2 — component/DOM tests.** `@testing-library/react`,
`@testing-library/dom` and `jsdom` are `ui/`-only devDependencies (the root
package's zero-runtime-dependency rule is untouched — nothing under `src/`
imports them); `vitest` is the runner (`ui/vitest.config.ts`,
`npm run test:dom` inside `ui/`), reusing the same Vite/Tailwind/React
plugin config the app itself builds with rather than a second bundler
config. These tests are not part of the root `npm test` gate — they run
under `ui/`, same as `ui/e2e/*` does. Discipline: assert semantics (roles,
accessible names, structure), never pixels — `ui/src/components/
KitchenSink.dom.test.tsx` is the example to copy from.

**The kitchen sink.** `index.html?kitchen-sink` (a query flag read once in
`ui/src/main.tsx`, not a router dependency — the shell has exactly one other
route) renders `ui/src/components/KitchenSink.tsx`: every primitive
(`ToolButton`, `PaneHeader`, `Row`, `Empty`, `Stub`), every severity colour,
the full type ramp, both elevation levels, the accent swatch and the syntax
palette, once each, plus one sample `FnSummary` fetched from `mockApi`
directly (never `./api.ts`) — it is the only consumer of `ui/src/mock.ts`
outside the api module. Because it needs no live project, it is the fastest
way to eyeball a token change across both theme slots before any real view
is touched (spec 20 §1.7 step 2).

**Layer 4 — visual regression.** `ui/e2e/visual.spec.ts` covers five views:
kitchen sink × (dark, light) — bur 12's two default slots — plus listing,
the Xrefs tab and the Graph tab on the dark default only. Two rules keep
this from flaking or ballooning:

- **DOM structure is asserted unconditionally, in every test, before any
  pixel comparison.** A font-rendering difference between macOS and Linux
  CI can never fail these tests outright — at worst it fails only the
  pixel step, which is opt-in (below).
- **The pixel comparison (`expect(page).toHaveScreenshot(...)`) runs only
  when `HBC2JS_E2E_VISUAL=1` is set.** `ui/e2e/playwright.config.ts` sets a
  3% `maxDiffPixelRatio` and disables CSS animations for the comparison;
  the suite also fixes the viewport (1280×800) and `reducedMotion: "reduce"`
  globally so a screenshot never depends on window size or lands mid
  transition. Regenerate with `HBC2JS_E2E_VISUAL=1 npx playwright test
  --config e2e/playwright.config.ts e2e/visual.spec.ts --update-snapshots`
  against the throwaway fixture rig only (never `PW_BASE_URL`, so a
  baseline can never drift with whatever bundle Fred happens to have open).

**Golden rule.** Baselines under `ui/e2e/__screenshots__/**` are golden
artifacts: the first commit and every regeneration are a Fred-approved
batch (CLAUDE.md testing rules, `docs/CONSOLIDATION.md` §B item 9). They are
a UI-private fixture — nothing under `tests/fixtures/constructs/**` feeds
them — so the "no exact-output assertions on shared fixtures" rule (item 7)
does not apply, but item 9's approval-as-a-batch rule still does.

**The reference-driven screenshot loop** (spec 20 §1.4, `docs/ui-refs/
README.md`), mechanically: implement a view → screenshot it → sit it next
to the matching reference in `docs/ui-refs/` → answer the four-question
checklist there (flat chrome? dense code pane? tight tree indent? exactly
one accent?) → any "no" is a token value (`ui/themes/*.json`) or a
structural fix, never a taste call → re-screenshot → repeat until every
question is "yes" → only then does the view get a `ui/e2e/visual.spec.ts`
baseline (spec 19 §1.2's bandwidth rule: screenshot at checkpoints, not per
tweak).
