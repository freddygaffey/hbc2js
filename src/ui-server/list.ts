// src/ui-server/list.ts — docs/specs/22-ui-mvp.md §3 `src/ui-server/` layer.
//
// Two small "walk everything" list helpers the UI needs (`/api/modules`,
// `/api/functions`) that `src/mcp/resources.ts` deliberately does not carry
// (spec 17 §14 cut whole-graph/whole-catalogue reads; this ui-server layer
// is allowed to add its OWN bounded list on top, per this task's brief —
// "add a small list method to your own layer, NOT to resources.ts"). Both
// stay honest about the two artifact backings (`.hbcproj` DB vs `index/
// *.jsonl`) the same way `ArtifactService`'s own constructor does, without
// duplicating its private parsing: DB-backed reuses `loadIndexRowsFromDb`
// (already exported by `src/projdb/artifact-read.ts`), JSONL-backed reads
// the same `index/modules.json` file `ArtifactService` reads.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactService, FnSummary } from "../artifact/service.ts";
import type { ModuleEntry, ModulesIndex } from "../artifact/schema.ts";
import { hasProjectDb, openProjectDbReadonly, loadIndexRowsFromDb } from "../projdb/artifact-read.ts";
import type { ProjectService } from "../project/service.ts";

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

export function listModules(artifactDir: string): ModuleListResult {
  let modules: readonly ModuleEntry[];
  if (hasProjectDb(artifactDir)) {
    const db = openProjectDbReadonly(artifactDir);
    try {
      modules = loadIndexRowsFromDb(db).modulesIndex.modules;
    } finally {
      db.close();
    }
  } else {
    const raw = JSON.parse(readFileSync(join(artifactDir, "index", "modules.json"), "utf8")) as ModulesIndex;
    modules = raw.modules;
  }
  return { rows: modules.slice(0, CAP_MODULES), total: modules.length, truncated: modules.length > CAP_MODULES };
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
    return { fn, name: s.overlayName ?? s.name, size, module: s.module };
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
export function invalidateModuleSourceCache(artifact: ArtifactService, fn: number): void {
  const cache = moduleSourceCache.get(artifact);
  if (cache === undefined) return;
  const mod = artifact.fn(fn).module;
  if (mod !== null) cache.delete(mod);
}

export function moduleSource(artifact: ArtifactService, project: ProjectService, id: number): ModuleSourceResult | null {
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
  for (const f of artifact.ownedFns(id)) if (f.lines !== null) functions.push({ fn: f.fn, name: f.name, lines: f.lines });
  functions.sort((a, b) => a.lines[0] - b.lines[0]);

  const diskText = readFileSync(artifact.modulePath(file), "utf8");
  const hasActive = functions.some((f) => project.activeRegNames(f.fn).size > 0);
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
    const names = project.activeRegNames(f.fn);
    const rendered = names.size > 0 ? artifact.renderFn(f.fn) : null;
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
