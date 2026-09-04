// src/ui-server/segregation.ts — `GET /api/segregation`, the name-recovery
// view of the module catalogue (docs/UI.md route table).
//
// Why this route exists at all: a real Metro bundle has NO module paths.
// `ModuleEntry.file` is `module_<id>.js` for every one of a Service NSW-sized
// 4 510-module bundle, so `ui/src/listing/modules.ts`'s `groupModules` — which
// groups by `file` — puts all of them in one `src/` group. Useless as a tree.
// `src/split/segregate.ts` already recovers structure from the decompiled
// text itself (`src/screens/*Screen.js`, `src/navigation/*`, `node_modules/
// <pkg>/…`, `_unclassified/…`); this route projects that, and only that, at
// the UI. It computes nothing of its own and never changes segregate's
// semantics — a different answer here than from `hbc2js segregate` would be a
// bug in this file.
//
// Cost: measured on Service NSW, 0.5 s to read the 4 511 module files + 4.6 s
// to segregate them. Far too slow per request, entirely fine once per server
// process — so the result is cached against the ctx object (below) and every
// later call is a map lookup. Deliberately NOT built from `artifact.fn()`
// rows: that would be O(native rows) on every call.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { segregateSplitTree, type SegregationBucket } from "../split/segregate.ts";
import type { DepsReport } from "../deps/report.ts";
import type { McpResources } from "../mcp/resources.ts";

/** One module, as the tree needs it. A projection of `SegregatedModuleInfo`
 *  (src/split/segregate.ts) minus the fields the UI has no use for
 *  (`originalFile` is `module_<id>.js` on a real bundle; `classification` is
 *  an input to `bucket`, not extra information). */
export interface SegregationRow {
  readonly id: number;
  /** `SegregatedModuleInfo.newPath` — path in the segregated tree, posix
   *  separators, e.g. `"src/screens/HomeScreen.js"`. */
  readonly path: string;
  readonly bucket: SegregationBucket;
  readonly package: string | null;
  readonly nameSignal: string | null;
  readonly nameConfidence: number | null;
}

/** The five counts are DISJOINT and sum to `modules.length`: `screens` and
 *  `navigation` are the two `src/` sub-trees the analyst works in first, and
 *  `src` is every OTHER `bucket === "src"` module (the "App" group in the
 *  tree). Reading `src` as "all app modules" would double-count. */
export interface SegregationCounts {
  readonly screens: number;
  readonly navigation: number;
  readonly src: number;
  readonly node_modules: number;
  readonly unclassified: number;
}

export interface SegregationResult {
  /** Sorted by module id. */
  readonly modules: readonly SegregationRow[];
  readonly counts: SegregationCounts;
  /** True once the deps stage (`McpResources.depsReport()`, spec 15's
   *  signature DB against the `--hbc` bundle) has settled for this ctx AND,
   *  if it produced a report, that report has been fed into THIS
   *  snapshot's `segregateSplitTree` call — so third-party modules are
   *  filed under `node_modules/<pkg>/…` and `SegregationRow.package` is
   *  filled where the deps run could attribute one. `false` on the fast
   *  first snapshot `server.ts` warms at listen (deps has not had a chance
   *  to run yet); becomes `true` on the ONE async recompute that follows,
   *  even when deps came back `null` (no `--hbc` configured, or no
   *  attributable inventory) — a settled "no deps" is still settled, so
   *  the UI's poll loop (`ui/src/hooks/use-segregation.ts`, re-fetches
   *  `/api/segregation` every 5 s while this is `false`) always
   *  terminates. */
  readonly depsApplied: boolean;
}

/** Everything this module needs from `UiServerCtx` (structural, so routes.ts
 *  can import this file without an import cycle). `resources` is read only
 *  for its `depsReport()` — never for `artifact`/`project` — so the async
 *  deps recompute below reuses the SAME cached `deps` run `/api/package-id`
 *  triggers, rather than starting a second one. */
export interface SegregationCtx {
  readonly artifactDir: string;
  readonly resources: McpResources;
}

export const SCREENS_PREFIX = "src/screens/";
export const NAVIGATION_PREFIX = "src/navigation/";

/** Where the `module_<id>.js` files actually live. Same two candidates, in
 *  the same order, as `ArtifactService.modulePath` (src/artifact/service.ts):
 *  a `--split` artifact writes them at the artifact root, an `hbc2js init`
 *  project under `<artifactDir>/src`. `null` = neither holds modules. */
export function moduleDirOf(artifactDir: string): string | null {
  for (const dir of [artifactDir, join(artifactDir, "src")]) {
    if (!existsSync(dir)) continue;
    let names: readonly string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    if (names.some((n) => /^module_\d+\.js$/.test(n))) return dir;
  }
  return null;
}

/** The `Map<name, text>` `segregateSplitTree` consumes. Deliberately NOT
 *  `readSplitDir` (src/split/segregate.ts), which reads EVERY top-level entry
 *  as UTF-8: a live project directory is not a pristine `--split` output —
 *  it also holds `project.hbcproj` (a multi-megabyte SQLite file, plus its
 *  `-wal`/`-shm` siblings) and sub-directories like `analysis/` and `log/`,
 *  and `readFileSync` on a directory throws `EISDIR`. Only `*.js` (the module
 *  files and `index.js`) and `MODULES.json` are inputs to segregation, so
 *  only those are read. `readSplitDir`'s own semantics are untouched. */
function readModuleTree(dir: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".js") && entry.name !== "MODULES.json") continue;
    files.set(entry.name, readFileSync(join(dir, entry.name), "utf8"));
  }
  return files;
}

function countsOf(modules: readonly SegregationRow[]): SegregationCounts {
  let screens = 0;
  let navigation = 0;
  let src = 0;
  let nodeModules = 0;
  let unclassified = 0;
  for (const m of modules) {
    if (m.bucket === "node_modules") nodeModules += 1;
    else if (m.bucket === "unclassified") unclassified += 1;
    else if (m.path.startsWith(SCREENS_PREFIX)) screens += 1;
    else if (m.path.startsWith(NAVIGATION_PREFIX)) navigation += 1;
    else src += 1;
  }
  return { screens, navigation, src, node_modules: nodeModules, unclassified };
}

/** The uncached computation, exported for tools/tests that hold a directory
 *  rather than a ctx. Returns `null` when `dir` has no module files. `deps`/
 *  `depsApplied` are threaded straight through to `SegregationResult` —
 *  `null`/`false` (the defaults) reproduce the pre-deps behaviour exactly. */
export function segregationOf(artifactDir: string, deps: DepsReport | null = null, depsApplied = false): SegregationResult | null {
  const dir = moduleDirOf(artifactDir);
  if (dir === null) return null;
  let result;
  try {
    result = segregateSplitTree(readModuleTree(dir), deps);
  } catch {
    // No MODULES.json (or an unreadable one): the tree cannot be recovered,
    // which the UI treats exactly like "no module dir" — it falls back to
    // the flat `groupModules` view rather than showing a blank tree.
    return null;
  }
  const modules: SegregationRow[] = result.modules
    .map((m) => ({ id: m.id, path: m.newPath, bucket: m.bucket, package: m.package, nameSignal: m.nameSignal, nameConfidence: m.nameConfidence }))
    .sort((a, b) => a.id - b.id);
  return { modules, counts: countsOf(modules), depsApplied };
}

/** One entry per ctx, computed on first request. A `WeakMap` rather than a
 *  field on `UiServerCtx` so the ctx stays the readonly value `handle()`
 *  treats it as, and so a test can build a throwaway ctx without a cache
 *  slot to reset. `null` is cached too: a project with no module dir must
 *  not re-`readdir` on every poll. */
const cache = new WeakMap<SegregationCtx, SegregationResult | null>();

/** One entry per ctx, set once the async deps recompute below has been
 *  STARTED for it — guards against `segregation()` kicking off a second
 *  `depsReport()`/`segregateSplitTree` run on every poll while the first is
 *  still in flight. */
const depsStarted = new WeakSet<SegregationCtx>();

/** The deps-aware recompute: awaits `ctx.resources.depsReport()` (cached on
 *  the `McpResources` instance — this never duplicates a `deps` run
 *  `/api/package-id` already started or will start) and, if the base
 *  directory still segregates, REPLACES the cache entry with a fresh
 *  `SegregationResult` computed WITH that report, `depsApplied: true`.
 *  Runs at most once per ctx (`depsStarted` above); failures leave the
 *  deps-less snapshot in place but still flip `depsApplied` so the UI's
 *  poll loop terminates rather than retrying forever. */
async function applyDepsWhenReady(ctx: SegregationCtx): Promise<void> {
  let report: DepsReport | null = null;
  try {
    report = await ctx.resources.depsReport();
  } catch {
    report = null;
  }
  // A ctx with no module dir cached `null` up front; deps can't change
  // that (`segregateSplitTree` never ran), so nothing to recompute — but
  // the entry must still exist for `cache.has` below to have fired.
  if (!cache.has(ctx)) return;
  const recomputed = segregationOf(ctx.artifactDir, report, true);
  cache.set(ctx, recomputed);
}

/** `GET /api/segregation`. Identical (`===`) on every call after the first
 *  for the same ctx UNTIL the async deps recompute lands — that identity is
 *  the cache contract the tests assert for the synchronous, deps-less
 *  window; the recompute deliberately swaps in a NEW object (real
 *  attribution replaces the placeholder one, `depsApplied` flips) once it
 *  finishes, which is the signal the UI polls on. */
export function segregation(ctx: SegregationCtx): SegregationResult | null {
  if (!cache.has(ctx)) {
    const computed = segregationOf(ctx.artifactDir);
    cache.set(ctx, computed);
  }
  if (!depsStarted.has(ctx)) {
    depsStarted.add(ctx);
    void applyDepsWhenReady(ctx);
  }
  return cache.get(ctx) ?? null;
}

/** True once `segregation(ctx)` has run for this ctx (test/introspection). */
export function segregationCached(ctx: SegregationCtx): boolean {
  return cache.has(ctx);
}
