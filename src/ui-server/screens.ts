// src/ui-server/screens.ts — `GET /api/screens`, the hierarchical screens
// tree with navigation edges (docs/specs/26-ui-full-ide.md L4, row 11 of its
// §1.2 delta table).
//
// Why a route of its own rather than more fields on `/api/segregation`:
// segregation answers "which bucket does this module belong in", is cached
// per server process and is polled by the left pane until it settles. This
// route answers a different question — "which screen owns which, and which
// screen navigates to which" — and it needs the call graph as well as the
// segregated tree. Keeping them apart means the (expensive, once-per-ctx)
// screens computation never delays the tree the pane paints first.
//
// EVERY field here is derived server-side from data the pipeline already
// proved (L4's own rule: "never from a name heuristic in the UI"):
//
//   * which modules are screens/navigators — `src/split/segregate.ts`'s own
//     `src/screens/…` / `src/navigation/…` placement, projected through
//     `segregation.ts`. This file never re-detects a navigator.
//   * children — the module dependency edges recorded in the artifact
//     (`ArtifactService.module(id).deps`), restricted to modules that are
//     themselves screens/navigators.
//   * `navigatesTo` with `confidence: "points-to"` — ONLY the `require(N)`
//     points-to edges (`index/calls-resolved.jsonl`, spec 17 §14.4), read
//     back through `ArtifactService.callsFrom`, which stamps them
//     `confidence: "points-to"` and names the module they resolved to. A
//     direct `calls.jsonl` edge is NOT a navigation edge and is never
//     promoted to one.
//   * `navigatesTo` with `confidence: "by-name"` — a `navigate("X")`-family
//     call in the screen's own decompiled text whose literal matches another
//     screen's label. A NAME match, never a proven edge, and marked as such
//     so the UI draws it dashed (spec 25 §3's rule for by-name edges, the
//     same idiom as `who-calls-by-name`).
//
// Cost: one pass over the screen modules only (a few hundred at most on a
// 4.5k-module bundle), cached against the ctx exactly as `segregation.ts`
// caches its own answer.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NAVIGATION_PREFIX, SCREENS_PREFIX, moduleDirOf, segregation, type SegregationCtx, type SegregationRow } from "./segregation.ts";
import type { UiRequest, UiResponse, UiServerCtx } from "./routes.ts";

export type ScreenKind = "screen" | "navigator";
export type NavConfidence = "points-to" | "by-name";

/** One screen -> screen navigation edge. `via` is the evidence's own name:
 *  the resolved export name for a points-to edge, the matched route literal
 *  for a by-name candidate. */
export interface ScreenNavEdge {
  readonly mod: number;
  readonly via: string;
  readonly confidence: NavConfidence;
}

/** One row of the screens tree. `children` are module ids of OTHER rows in
 *  the same answer (never a module that is not itself a screen row), and the
 *  child relation is a real tree: every module appears as a child of at most
 *  one parent and never of itself (see `buildScreens`). */
export interface ScreenRow {
  readonly mod: number;
  /** The module's factory function, i.e. what "open this screen" selects.
   *  `null` when the artifact records no owned function for the module. */
  readonly fn: number | null;
  readonly label: string;
  readonly kind: ScreenKind;
  readonly children: readonly number[];
  readonly navigatesTo: readonly ScreenNavEdge[];
}

export interface ScreensResult {
  readonly screens: readonly ScreenRow[];
  readonly total: number;
  /** Mirrors `SegregationResult.computing`: the segregation this is derived
   *  from has not settled yet, so `screens` is the empty placeholder and the
   *  client should poll (`ui/src/listing/use-screens.ts`). */
  readonly computing?: boolean;
}

/** The pure core, exported for tests: candidates in, tree out. Keeping it
 *  free of the artifact/segregation types is what lets the cycle and
 *  unknown-target rules be tested on synthetic input rather than on whatever
 *  a fixture bundle happens to contain. */
export interface ScreenCandidate {
  readonly mod: number;
  readonly label: string;
  readonly kind: ScreenKind;
  readonly fn: number | null;
  /** Module dependency ids, unfiltered — `buildScreens` keeps only the ones
   *  that are candidates themselves. */
  readonly deps: readonly number[];
}

export interface RawNavEdge {
  readonly from: number;
  readonly to: number;
  readonly via: string;
  readonly confidence: NavConfidence;
}

function edgeKey(e: RawNavEdge): string {
  return `${e.from}>${e.to}:${e.via}:${e.confidence}`;
}

/** Tree projection + edge filtering.
 *
 *  Children: a candidate's dependency is its child when the dependency is
 *  itself a candidate, is not the candidate, and has not already been
 *  claimed by another parent. Claims are resolved in a deterministic order
 *  (navigators first — a navigator owning its screens is the relation the
 *  analyst wants at the top of the tree — then by module id), and a claim is
 *  refused when it would close a cycle (`wouldCycle`), so the result is
 *  always a forest: no module is its own ancestor and no module appears
 *  twice.
 *
 *  Edges: an edge whose target is not a candidate is DROPPED, never emitted
 *  as a stub node — the tree only ever names modules it can also show. Self
 *  edges are dropped for the same reason (a screen that navigates to itself
 *  is a re-render, not a navigation the tree can draw). Duplicates collapse. */
export function buildScreens(candidates: readonly ScreenCandidate[], edges: readonly RawNavEdge[]): ScreensResult {
  const byMod = new Map<number, ScreenCandidate>();
  for (const c of candidates) if (!byMod.has(c.mod)) byMod.set(c.mod, c);
  const order = [...byMod.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "navigator" ? -1 : 1) || a.mod - b.mod);

  const parentOf = new Map<number, number>();
  const childrenOf = new Map<number, number[]>();
  const wouldCycle = (parent: number, child: number): boolean => {
    let at: number | undefined = parent;
    for (let guard = 0; at !== undefined && guard <= byMod.size; guard++) {
      if (at === child) return true;
      at = parentOf.get(at);
    }
    return false;
  };
  for (const c of order) {
    const kids: number[] = [];
    for (const dep of c.deps) {
      if (dep === c.mod || !byMod.has(dep)) continue;
      if (parentOf.has(dep)) continue;
      if (wouldCycle(c.mod, dep)) continue;
      parentOf.set(dep, c.mod);
      kids.push(dep);
    }
    childrenOf.set(c.mod, kids.sort((a, b) => a - b));
  }

  const navOf = new Map<number, ScreenNavEdge[]>();
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    if (!byMod.has(e.from) || !byMod.has(e.to)) continue;
    const key = edgeKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    const list = navOf.get(e.from) ?? [];
    list.push({ mod: e.to, via: e.via, confidence: e.confidence });
    navOf.set(e.from, list);
  }

  const screens: ScreenRow[] = [...byMod.values()]
    .sort((a, b) => a.label.localeCompare(b.label) || a.mod - b.mod)
    .map((c) => ({
      mod: c.mod,
      fn: c.fn,
      label: c.label,
      kind: c.kind,
      children: childrenOf.get(c.mod) ?? [],
      navigatesTo: (navOf.get(c.mod) ?? []).sort((a, b) => a.mod - b.mod || a.via.localeCompare(b.via)),
    }));
  return { screens, total: screens.length };
}

/** `src/screens/HomeScreen.js` -> `HomeScreen`. */
export function screenLabelOf(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return base.replace(/\.[jt]sx?$/, "");
}

function kindOf(row: SegregationRow): ScreenKind | null {
  if (row.bucket !== "src") return null;
  if (row.path.startsWith(SCREENS_PREFIX)) return "screen";
  if (row.path.startsWith(NAVIGATION_PREFIX)) return "navigator";
  return null;
}

/** The `navigate`-family calls whose argument is a string literal. Route
 *  names are the argument of exactly these react-navigation methods; the
 *  list is deliberately closed rather than "any call taking a string", so a
 *  by-name candidate always has a navigation-shaped call behind it as well
 *  as a name match. */
const NAV_CALL_RE = /\.\s*(navigate|push|replace|jumpTo|navigateDeprecated|resetRoot|popTo)\s*\(\s*(['"])([^'"\n]{1,80})\2/g;

/** By-name candidates for one module's decompiled text: a nav-shaped call
 *  whose literal matches another screen's label (exactly, or with the
 *  conventional `Screen` suffix that `segregate.ts` keeps in the file name
 *  — `navigate("Home")` reaching `src/screens/HomeScreen.js`). Exported for
 *  tests: this is the only heuristic in the file and it is the one that must
 *  never be mistaken for a proven edge. */
export function byNameEdgesOf(from: number, text: string, labelToMod: ReadonlyMap<string, number>): readonly RawNavEdge[] {
  const out: RawNavEdge[] = [];
  for (const m of text.matchAll(NAV_CALL_RE)) {
    const literal = m[3]!;
    const to = labelToMod.get(literal) ?? labelToMod.get(`${literal}Screen`);
    if (to === undefined) continue;
    out.push({ from, to, via: literal, confidence: "by-name" });
  }
  return out;
}

/** Everything this module needs from `UiServerCtx` (structural, so
 *  `routes.ts` can register the route without an import cycle). */
export interface ScreensCtx extends SegregationCtx {
  readonly artifactDir: string;
}

const cache = new WeakMap<ScreensCtx, ScreensResult>();

function readModuleText(dir: string | null, file: string | null): string | null {
  if (dir === null || file === null) return null;
  const path = join(dir, file);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** `GET /api/screens`. `null` = this project has no segregated module tree
 *  at all (the route answers 404, same condition as `/api/segregation`). */
export function screensOf(ctx: ScreensCtx): ScreensResult | null {
  const cached = cache.get(ctx);
  if (cached !== undefined) return cached;
  const seg = segregation(ctx);
  if (seg === null) return null;
  // Not settled yet: answer the same placeholder shape segregation does
  // rather than caching a tree built from an empty module list.
  if (seg.computing === true) return { screens: [], total: 0, computing: true };

  const artifact = ctx.resources.artifact;
  const dir = moduleDirOf(ctx.artifactDir);
  const candidates: ScreenCandidate[] = [];
  const texts = new Map<number, string | null>();
  for (const row of seg.modules) {
    const kind = kindOf(row);
    if (kind === null) continue;
    const info = artifact.module(row.id);
    const owned = artifact.ownedFns(row.id);
    let fn: number | null = null;
    for (const o of owned) if (fn === null || o.fn < fn) fn = o.fn;
    candidates.push({ mod: row.id, label: screenLabelOf(row.path), kind, fn, deps: info.deps });
    texts.set(row.id, readModuleText(dir, info.file));
  }

  const labelToMod = new Map<string, number>();
  for (const c of candidates) if (!labelToMod.has(c.label)) labelToMod.set(c.label, c.mod);

  const edges: RawNavEdge[] = [];
  for (const c of candidates) {
    // Proven edges: the points-to pass resolved a call in one of this
    // module's functions to another module's export.
    for (const o of artifact.ownedFns(c.mod)) {
      for (const e of artifact.callsFrom(o.fn, { all: true }).rows) {
        if (e.confidence !== "points-to" || e.module === undefined) continue;
        edges.push({ from: c.mod, to: e.module, via: e.exportName ?? "", confidence: "points-to" });
      }
    }
    const text = texts.get(c.mod) ?? null;
    if (text !== null) edges.push(...byNameEdgesOf(c.mod, text, labelToMod));
  }

  const result = buildScreens(candidates, edges);
  cache.set(ctx, result);
  return result;
}

// `routes.ts` keeps its own private `Route` shape (there is exactly one
// `handle()`); this mirrors `workers-routes.ts` and is spliced into that
// table by ONE line there:
//   const ROUTES = [...BASE_ROUTES, ...WORKER_ROUTES, ...SCREENS_ROUTES];
interface Route {
  readonly method: "GET" | "POST";
  readonly re: RegExp;
  readonly handler: (params: readonly string[], req: UiRequest, ctx: UiServerCtx) => UiResponse | Promise<UiResponse>;
}

export const SCREENS_ROUTES: readonly Route[] = [
  {
    method: "GET",
    re: /^\/api\/screens$/,
    handler: (_p, _req, ctx) => {
      const r = screensOf(ctx);
      if (r === null) return { status: 404, json: { reason: "screens: this project has no module_<id>.js files to segregate" } };
      return { status: 200, json: r };
    },
  },
];
