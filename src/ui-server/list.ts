// src/ui-server/list.ts — docs/specs/22-ui-mvp.md §3 `src/ui-server/` layer.
//
// Two small "walk everything" list helpers the UI needs (`/api/modules`,
// `/api/functions`) that `src/mcp/resources.ts` deliberately does not carry
// (spec 17 §14 cut whole-graph/whole-catalogue reads; this ui-server layer
// is allowed to add its OWN bounded list on top, per this task's brief —
// "add a small list method to your own layer, NOT to resources.ts"). Both
// stay honest about the two artifact backings (`.hbcproj` DB vs `index/
// *.jsonl`) the same way `ArtifactService`'s own constructor does, without
// duplicating its private parsing: DB-backed queries the same `ix_modules`/
// `ix_module_deps` tables `loadIndexRowsFromDb` (`src/projdb/artifact-read.ts`)
// builds its `modulesIndex` from, JSONL-backed reads the same
// `index/modules.json` file `ArtifactService` reads.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { ArtifactService, FnSummary } from "../artifact/service.ts";
import type { McpResources } from "../mcp/resources.ts";
import type { ModuleEntry, ModulesIndex } from "../artifact/schema.ts";
import { hasProjectDb, openProjectDbReadonly, dbPath } from "../projdb/artifact-read.ts";
import type { ProjectService } from "../project/service.ts";
import type { LeadsWorkerMessage } from "../workers/leads-worker.ts";

/** Every module the artifact knows about — own cap (never widens anything
 *  `resources.ts` publishes; this is a new list this layer owns). The UI's
 *  module tree needs the whole list in one response: a real 12 MB RN app
 *  (Service NSW) has 4,510 modules, so 500 truncated the tree to a ninth of
 *  the app. Rows are ~60 bytes each; 20,000 is ~1 MB, plenty of headroom. */
export const CAP_MODULES = 20_000;

export interface ModuleListResult {
  readonly rows: readonly ModuleEntry[];
  readonly total: number;
  readonly truncated: boolean;
}

/** Cache entry for {@link listModules}, stamped with the artifact file it was
 *  read from so a re-decompiled (or written-to) project is never served from
 *  a stale answer — see {@link listModules}'s own note. */
interface ModuleListCacheEntry {
  readonly stamp: string;
  readonly result: ModuleListResult;
}

const modulesCache = new Map<string, ModuleListCacheEntry>();

/** `mtime:size` of the file the module list comes from — cheap enough to
 *  `stat` on every request, and it changes whenever the artifact does.
 *  A file we cannot stat stamps as `"none"`, which is stable, so a missing
 *  file still errors in the read below rather than here. */
function fileStamp(file: string): string {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "none";
  }
}

/** Only `ix_modules` + `ix_module_deps`. `loadIndexRowsFromDb` (the obvious
 *  reuse, and what this used to call) materialises EVERY index — functions,
 *  calls, strings, string uses, globals, native, ranges — to hand back one
 *  of them; on Service NSW that is 3.15 s per `/api/modules`, on the
 *  critical path of the shell's first paint (docs/reports/
 *  2026-09-05-ui-first-paint.md). The two queries below are the module half
 *  of that function, verbatim in shape, so the rows are identical. */
function modulesFromDb(artifactDir: string): readonly ModuleEntry[] {
  const db = openProjectDbReadonly(artifactDir);
  try {
    const rows = db.prepare("SELECT id, file, factory_fn, segment FROM ix_modules ORDER BY id").all() as {
      id: number;
      file: string;
      factory_fn: number | null;
      segment: number;
    }[];
    const depsById = new Map<number, number[]>();
    for (const d of db.prepare("SELECT id, dep FROM ix_module_deps ORDER BY id, ord").all() as { id: number; dep: number }[]) {
      const list = depsById.get(d.id);
      if (list === undefined) depsById.set(d.id, [d.dep]);
      else list.push(d.dep);
    }
    return rows.map((m) => ({ id: m.id, file: m.file, factoryFn: m.factory_fn, deps: depsById.get(m.id) ?? [], segment: m.segment }));
  } finally {
    db.close();
  }
}

/** The module catalogue, cached for as long as the artifact file it was read
 *  from is untouched. `ModulesIndex` is `renderIndependent: true` — no name,
 *  comment, tag or finding a write tool records can change a row here — so
 *  the only thing that can invalidate it is the artifact itself changing,
 *  which the `mtime:size` stamp catches (a write to `project.hbcproj` bumps
 *  its mtime, so a rename over-invalidates rather than under-invalidates;
 *  the re-read is two small queries now, not the whole index). */
export function listModules(artifactDir: string): ModuleListResult {
  const fromDb = hasProjectDb(artifactDir);
  const file = fromDb ? dbPath(artifactDir) : join(artifactDir, "index", "modules.json");
  const stamp = fileStamp(file);
  const hit = modulesCache.get(artifactDir);
  if (hit !== undefined && hit.stamp === stamp) return hit.result;
  const modules: readonly ModuleEntry[] = fromDb
    ? modulesFromDb(artifactDir)
    : (JSON.parse(readFileSync(file, "utf8")) as ModulesIndex).modules;
  const result: ModuleListResult = {
    rows: modules.slice(0, CAP_MODULES),
    total: modules.length,
    truncated: modules.length > CAP_MODULES,
  };
  modulesCache.set(artifactDir, { stamp, result });
  return result;
}

/** `/api/leads` / `/api/leads/security-sinks` — `computeLeads` is a
 *  whole-bundle scan (37.7 s cold, 9.4 s warm on Service NSW). Node's
 *  server is single-threaded, so a call answered INLINE head-of-line-blocks
 *  every other route behind it: on the rig it was the reason
 *  `/api/segregation`, `/api/findings` and `/api/log/tail` all landed 41 s
 *  after the page asked for them (docs/UI-BURS.md bur 1 row 2). Spec 26 L6
 *  makes the Leads tab load-bearing (lead -> finding promotion), so this
 *  can no longer stay a "pay once, but pay inline" cache — the compute now
 *  runs on a `node:worker_threads` worker (`src/workers/leads-worker.ts`,
 *  the exact pattern `src/ui-server/segregation.ts` already uses for
 *  `segregateSplitTree`), and `listLeads` never blocks: it returns the
 *  `computing: true` placeholder immediately while the first call for an
 *  artifact is in flight, and the SAME settled object on every call after
 *  that (answer depends only on the artifact, never on project
 *  annotations). */
const LEADS_WORKER_URL = new URL("../workers/leads-worker.ts", import.meta.url);

const leadsCache = new WeakMap<ArtifactService, ReturnType<McpResources["leads"]>>();
const leadsComputing = new WeakSet<ArtifactService>();

const LEADS_PLACEHOLDER: ReturnType<McpResources["leads"]> = { groups: [], total: 0, truncated: false, computing: true };

function runLeadsWorker(artifactDir: string): Promise<ReturnType<McpResources["leads"]>> {
  return new Promise((resolvePromise, rejectPromise) => {
    let worker: Worker;
    try {
      worker = new Worker(LEADS_WORKER_URL, { workerData: { artifactDir } });
    } catch (err) {
      rejectPromise(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    worker.once("message", (msg: LeadsWorkerMessage) => {
      void worker.terminate();
      if (msg.ok) resolvePromise(msg.result);
      else rejectPromise(new Error(msg.error));
    });
    worker.once("error", (err) => rejectPromise(err));
  });
}

/** Never blocks: a fresh artifact returns the `computing: true` placeholder
 *  while the worker runs in the background; once it settles, every later
 *  call for the SAME artifact returns the identical (`===`) cached object,
 *  matching `segregation()`'s own settled-cache contract. */
export function listLeads(resources: McpResources, artifactDir: string): ReturnType<McpResources["leads"]> {
  const hit = leadsCache.get(resources.artifact);
  if (hit !== undefined) return hit;
  if (!leadsComputing.has(resources.artifact)) {
    leadsComputing.add(resources.artifact);
    void runLeadsWorker(artifactDir)
      .then((result) => leadsCache.set(resources.artifact, result))
      .catch(() => leadsCache.set(resources.artifact, { groups: [], total: 0, truncated: false }));
  }
  return LEADS_PLACEHOLDER;
}

/** `/api/functions?cursor=&limit=` — every function `{fn, name, size,
 *  module}`, paged like `search/functions` (`src/mcp/leads.ts`'s
 *  `paginate`) but with no name filter. Default page size (50) matches
 *  `search/functions` so the two feel consistent in the UI; a caller that
 *  wants the whole catalogue in fewer round trips (the left pane's
 *  `useFunctionCatalogue` hook, `ui/src/hooks.ts`) may ask for up to
 *  {@link FUNCTIONS_PAGE_MAX} at once — a real bundle (Service NSW) has
 *  ~15,000 functions, which the old fixed 50-row page made a 300-request
 *  walk; `?limit=1000` makes it 15. */
const FUNCTIONS_PAGE_CAP = 50;
export const FUNCTIONS_PAGE_MAX = 1000;

export interface FunctionListRow {
  readonly fn: number;
  readonly name: string | null;
  readonly size: number | null;
  readonly module: number | null;
}

export interface FunctionListPage {
  readonly rows: readonly FunctionListRow[];
  readonly total: number;
  readonly truncated: boolean;
  readonly nextCursor: number | null;
}

/** Clamps a caller-supplied `?limit=` into `[1, FUNCTIONS_PAGE_MAX]`,
 *  falling back to the default page size for anything absent or not a
 *  positive integer (never a 400 — an odd `limit` is just ignored). */
export function clampFunctionsLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return FUNCTIONS_PAGE_CAP;
  return Math.min(Math.floor(raw), FUNCTIONS_PAGE_MAX);
}

export function listFunctions(artifact: ArtifactService, cursor = 0, limit = FUNCTIONS_PAGE_CAP): FunctionListPage {
  const pageSize = clampFunctionsLimit(limit);
  const all = artifact.listFns();
  const start = Math.max(0, cursor);
  const page = all.slice(start, start + pageSize);
  const rows: FunctionListRow[] = page.map(({ fn }) => {
    const s: FnSummary = artifact.fn(fn);
    const size = s.lines !== null ? s.lines[1] - s.lines[0] + 1 : null;
    // `name` is the ONE name to show, most human first: the accepted
    // `fn:N` rename, then the register overlay's signal, then the bytecode
    // name (`ui/src/listing/names.ts` runs the same precedence). Before
    // this, a renamed function's row still showed the old name.
    return { fn, name: artifact.acceptedFnName(fn) ?? s.overlayName ?? s.name, size, module: s.module };
  });
  const nextCursor = start + rows.length < all.length ? start + rows.length : null;
  return { rows, total: all.length, truncated: all.length > pageSize, nextCursor };
}

/** `/api/module/{id}/source` — the whole module file plus every function
 *  it owns with its 1-based line range, so the UI can show a FILE view (all
 *  functions, click a range to focus one) instead of forcing the user down
 *  to per-function source (`/api/fn/{fn}/source`). Text is the artifact's
 *  own rendered `module_N.js` UNLESS a function in it has an accepted
 *  `reg:F:R` name (docs/UI.md "Still rough here" used to say this view was
 *  never overlay-aware) — that function's line range is then spliced with
 *  `ArtifactService.renderFn(fn)`'s re-emit, same source `/api/fn/{fn}/
 *  source` already serves, so the two views agree. `renderedFns` lists
 *  which owned functions were spliced. */
export interface ModuleSourceResult {
  readonly module: number;
  readonly file: string;
  readonly text: string;
  readonly functions: readonly { readonly fn: number; readonly name: string | null; readonly lines: readonly [number, number] }[];
  readonly renderedFns: readonly number[];
}

/** Per-module spliced result, keyed by the `ArtifactService` instance (one
 *  per project ctx, same identity `renderFn`'s own memoisation relies on) so
 *  a splice with no active names anywhere never recomputes on repeat reads,
 *  and a rename invalidates only the ONE module it lands in
 *  (`invalidateModuleSourceCache` below, called next to
 *  `ProjectService.invalidateRenderFor`'s own `artifact.invalidateRender`). */
const moduleSourceCache = new WeakMap<ArtifactService, Map<number, ModuleSourceResult>>();

/** Drops the cached `/api/module/{id}/source` splice for the module that
 *  owns `fn` (looked up live — `ArtifactService.fn` — so this stays correct
 *  even if a function moves module between builds). Called by the
 *  `set-name` route right after a write, mirroring `renderFn`'s own
 *  invalidation so the two caches never disagree about staleness. */
export function invalidateModuleSourceCache(artifact: ArtifactService, fn: number, opts: { readonly withCallers?: boolean } = {}): void {
  const cache = moduleSourceCache.get(artifact);
  if (cache === undefined) return;
  const drop = (f: number): void => {
    const mod = artifact.hasFn(f) ? artifact.fn(f).module : null;
    if (mod !== null) cache.delete(mod);
  };
  drop(fn);
  // A `fn:N` rename also changes every DIRECT CALLER's text (they reference
  // it by name), so their modules' splices are stale too. Bounded by the
  // call graph, never the whole bundle (docs/UI.md; a reference from a
  // function the call graph does not know about is docs/BUGS.md).
  if (opts.withCallers === true) for (const e of artifact.whoCalls(fn, { all: true }).rows) if (typeof e.fn === "number") drop(e.fn);
}

// `_project` is kept in the signature (every caller passes it) but no longer
// read: the accepted-name join moved into `ArtifactService.needsNameRender`,
// which knows about `fn:N` renames as well as `reg:F:R` ones.
export function moduleSource(artifact: ArtifactService, _project: ProjectService, id: number): ModuleSourceResult | null {
  let cache = moduleSourceCache.get(artifact);
  if (cache === undefined) {
    cache = new Map();
    moduleSourceCache.set(artifact, cache);
  }
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  const file = artifact.module(id).file;
  if (file === null) return null;
  const functions: { fn: number; name: string | null; lines: readonly [number, number] }[] = [];
  for (const f of artifact.ownedFns(id)) if (f.lines !== null) functions.push({ fn: f.fn, name: artifact.acceptedFnName(f.fn) ?? f.name, lines: f.lines });
  functions.sort((a, b) => a.lines[0] - b.lines[0]);

  const diskText = readFileSync(artifact.modulePath(file), "utf8");
  // `needsNameRender` is the artifact's own answer to "is the text on disk
  // stale against the accepted names?" -- named registers, a `fn:N` rename
  // of this function, or a `fn:N` rename of something it calls.
  const hasActive = functions.some((f) => artifact.needsNameRender(f.fn));
  if (!hasActive) {
    // Untouched path stays byte-identical to disk — no split/join, no
    // render call — per this module's own doc comment above.
    const result: ModuleSourceResult = { module: id, file, text: diskText, functions, renderedFns: [] };
    cache.set(id, result);
    return result;
  }

  const workingLines = diskText.split("\n");
  let delta = 0;
  const renderedFns: number[] = [];
  const outFunctions: { fn: number; name: string | null; lines: [number, number] }[] = [];
  for (const f of functions) {
    const adjLo = f.lines[0] + delta;
    const adjHi = f.lines[1] + delta;
    const rendered = artifact.needsNameRender(f.fn) ? artifact.renderFn(f.fn) : null;
    if (rendered === null) {
      outFunctions.push({ fn: f.fn, name: f.name, lines: [adjLo, adjHi] });
      continue;
    }
    // Indent every rendered line to the original range's own leading
    // whitespace (the module file's function statements may be nested,
    // e.g. inside the `__d(function(...) {` wrapper); rendered.code itself
    // has no baseline indentation, so this is a straight prepend, and
    // trailing-empty lines are trimmed rather than indented.
    const leading = /^[ \t]*/.exec(workingLines[adjLo - 1] ?? "")?.[0] ?? "";
    const renderedLines = rendered.code
      .replace(/\n+$/, "")
      .split("\n")
      .map((l) => (l.length === 0 ? l : leading + l));
    workingLines.splice(adjLo - 1, adjHi - adjLo + 1, ...renderedLines);
    const newHi = adjLo + renderedLines.length - 1;
    outFunctions.push({ fn: f.fn, name: f.name, lines: [adjLo, newHi] });
    renderedFns.push(f.fn);
    delta += renderedLines.length - (adjHi - adjLo + 1);
  }

  const result: ModuleSourceResult = { module: id, file, text: workingLines.join("\n"), functions: outFunctions, renderedFns };
  cache.set(id, result);
  return result;
}
