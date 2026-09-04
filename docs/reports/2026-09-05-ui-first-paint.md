# UI first paint — measurement and fix (bur 1)

Fred, 2026-09-05: *"the UI on refresh takes a long time to show anything —
this is bad; it is all computed in the db, right?"*

It is all in the DB. The delay was not rendering and not the database: it was
**head-of-line blocking**. `src/ui-server` is one single-threaded Node
process, so one long synchronous route makes every other request queue behind
it, however cheap that other request is.

## Before — cold load of the shell against the live Service NSW rig

Headless Chromium (Playwright) against `http://127.0.0.1:4173` (the rig's
`vite preview`), API at `http://127.0.0.1:7331`, project
`/Users/fred/hbc2js-ui-demo/nsw` (4,510 modules, ~15k functions). "start" and
"client ms" are from the browser; "server ms" is the server's own access-log
line for the same request.

| request | start (ms) | client ms | server ms | bytes |
|---|---:|---:|---:|---:|
| `GET /` (shell HTML) | 6 | 17 | — | 884 |
| `fonts.googleapis.com/css2` | 23 | 529 | — | 11,495 |
| `GET /api/modules` | 597 | 3,155 | **3,154** | 422,755 |
| `GET /api/leads` | 597 | 40,893 | **37,739** | 12,165 |
| `GET /api/segregation` | 597 | 40,976 | 3 | 602,722 |
| `GET /api/findings` | 597 | 40,977 | 1 | 39 |
| `GET /api/log/tail?since=0` | 598 | 40,976 | 0 | 1,101 |
| `GET /api/events` (SSE) | 597 | — | 1 | — |
| `GET /api/module/4083/source` | 41,572 | 49 | 15 | 9,682 |
| `GET /api/module/4083` | 41,572 | 50 | 2 | 97 |

Page marks: `load` 548 ms, **first module row 42,092 ms, first function row
42,084 ms**.

Read the middle of the table: `segregation`, `findings` and `log/tail` cost
0–3 ms *of server time* and yet all three landed at ~41 s. They were sitting
in the accept queue while `/api/leads` ran. Two offenders, in measured order:

1. **`GET /api/leads` — 37.7 s cold (9.4 s warm), fired on every page load.**
   `computeLeads` is a whole-bundle scan. `ui/src/panes/LeftPane.tsx` called
   `useLeads()` unconditionally at the top of the component even though the
   Leads tab is not the tab a fresh shell shows — Radix does not even mount
   that tab's content. So every refresh paid the scan, and blocked everything
   else behind it, for a list nobody had asked to see.
2. **`GET /api/modules` — 3.15 s cold (0.6 s warm).** The DB-backed path went
   through `loadIndexRowsFromDb`, which materialises *every* index —
   functions, calls, strings, string uses, globals, native, ranges — to
   return one of them. The module tree is the first thing the shell paints.

Not offenders, measured and cleared: `/api/segregation` (3 ms — the startup
prewarm already does its work), `/api/findings` (1 ms), `/api/log/tail`
(0 ms), the 500 ms `/api/events` poll (server-side, not a request per tick),
the shell bundle (548 ms `load`, and the tree is not waiting on it),
`useSelection().fn ?? 0` (already fixed before this task: `App.tsx` uses
`?? -1` and no route 4xx'd during the whole load).

## What changed

* `src/ui-server/list.ts` — `listModules` queries `ix_modules` +
  `ix_module_deps` directly instead of loading the whole index, and caches
  the result per artifact directory, stamped with the source file's
  `mtime:size` so a re-decompile (or any write to `project.hbcproj`)
  invalidates it. `ModulesIndex` is `renderIndependent: true`, so no
  annotation can change a row.
* `src/ui-server/list.ts` / `routes.ts` — new `listLeads(resources)` memoises
  `resources.leads()` per `ArtifactService` (a `WeakMap`); `/api/leads` and
  `/api/leads/security-sinks` both go through it. The scan depends only on
  the artifact, which does not change while the server runs.
* `ui/src/hooks.ts` — `useLeads(enabled = true)`, `staleTime: Infinity`.
* `ui/src/panes/LeftPane.tsx` — the tab list is controlled; `useLeads` is
  enabled only once the analyst has opened the Leads tab (and stays enabled
  after, so switching back to Modules does not discard the answer).

## After

| measurement | before | after |
|---|---:|---:|
| `listModules` on the NSW artifact, cold process | 3,154 ms | **17 ms** |
| `listModules`, second call (cached) | 3,154 ms | **0 ms** |
| `/api/modules` payload (unchanged, byte for byte) | 422,755 | 422,755 |
| `/api/leads` requests during a page load | 1 (37.7 s, blocking) | **0** |
| `/api/leads` second call in a session | 9.4 s | 0 ms (cached) |
| e2e fixture: tree + module + function rows visible | — | **792 ms** (whole test) |

The NSW load path after the fix is `modules` 17 ms + `segregation` ~14 ms +
`findings`/`log-tail` ~3 ms, none of them queued behind anything, i.e. the
tree paints as soon as the shell bundle has (548 ms in the trace above)
rather than 42 s later. That end-to-end number is a sum of parts, not a
measured rig reload: the rig at :7331/:4173 is the owner's live process and
still runs the pre-fix build — it has to be restarted (and `ui/dist` rebuilt)
to see it.

## Regression tests

* `ui/e2e/perf.spec.ts` — three tests: (a) tree + module row + function row
  visible inside the budget, (b) no `/api/leads` request during load, (c) no
  4xx response during load. Budget 10 s on the fixture (20 s against the
  rig): an order of magnitude above the honest number, because the box runs
  several agents at once — it is there to catch "the shell blocks on a
  whole-bundle scan again", not to police jitter.
* `tests/ui-server/routes.test.ts` — `listModules`'s narrow query equals
  `loadIndexRowsFromDb().modulesIndex.modules` row for row (and is cached);
  `listLeads` returns `resources.leads()` and computes it once.

## Still open

* **Head-of-line blocking is structural.** Opening the Leads tab still runs a
  37 s synchronous scan that freezes every other route for its duration —
  once per session now instead of once per refresh, and only when asked for,
  but the underlying "one long route stalls the server" property is
  unchanged. The real fix is the same one `docs/UI.md` "Cold start" describes
  for `rawFrames`: move the scan off the main thread (or make it incremental)
  — see `docs/BUGS.md`.
* The `/api/modules` payload is 422 kB for 4,510 modules, mostly `deps`
  arrays. On localhost that is a few ms; a `?fields=` projection would be a
  contract change and is not worth it until it measures.
