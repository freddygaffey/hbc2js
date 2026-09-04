// ui/src/listing/screens.ts — the screens tree, as pure functions (spec 26
// L4: "listing-2: hierarchical screens tree + navigation arrows").
//
// The SERVER decides what a screen is, who owns whom and which navigation
// edges are proven (src/ui-server/screens.ts, over `segregate.ts` plus the
// points-to index): this file never re-derives any of that from a name. What
// it does own is the PROJECTION into a tree the left pane can render, and
// the two safety rules that projection must hold to whatever the wire says:
//
//   * a module appears at most once in the tree, and never under itself —
//     a cyclic or double-claimed `children` list from any future server (or
//     from a hand-edited fixture) must not hang the renderer or duplicate a
//     row;
//   * a `navigatesTo` edge naming a module that is not itself a screen row
//     is DROPPED, never rendered as a stub node the analyst cannot open.
//
// Both are gate-tested (tests/gate/ui/screens-model.test.ts).
import type { ModuleEntry } from "./wire.ts";
import type { ModuleGroup } from "./modules.ts";
import { NAVIGATION_KEY, SCREENS_KEY } from "./modules.ts";

export type ScreenKind = "screen" | "navigator";
export type NavConfidence = "points-to" | "by-name";

/** `ScreenNavEdge` — src/ui-server/screens.ts. */
export interface ScreenNavEdge {
  readonly mod: number;
  readonly via: string;
  readonly confidence: NavConfidence;
}

/** `ScreenRow` — src/ui-server/screens.ts. */
export interface ScreenRow {
  readonly mod: number;
  readonly fn: number | null;
  readonly label: string;
  readonly kind: ScreenKind;
  readonly children: readonly number[];
  readonly navigatesTo: readonly ScreenNavEdge[];
}

/** `ScreensResult` — `GET /api/screens`. */
export interface ScreensPage {
  readonly screens: readonly ScreenRow[];
  readonly total: number;
  readonly computing?: boolean;
}

/** One node of the rendered hierarchy. */
export interface ScreenNode {
  readonly row: ScreenRow;
  readonly depth: number;
  readonly children: readonly ScreenNode[];
  /** `row.navigatesTo` with unknown targets already dropped. */
  readonly navigatesTo: readonly ScreenNavEdge[];
}

/** Rows by module id — built once per fetch. */
export function screensByMod(page: ScreensPage | null): ReadonlyMap<number, ScreenRow> {
  const out = new Map<number, ScreenRow>();
  if (page !== null) for (const r of page.screens) if (!out.has(r.mod)) out.set(r.mod, r);
  return out;
}

/** The hierarchy: navigators and screens nobody claims as a child are roots,
 *  every other row hangs under its FIRST claimant (a second claim is
 *  ignored, so no row is ever rendered twice), and a claim that would close
 *  a cycle is refused. `null`/empty page -> empty forest. */
export function screensTree(page: ScreensPage | null): readonly ScreenNode[] {
  const byMod = screensByMod(page);
  const parentOf = new Map<number, number>();
  for (const row of byMod.values()) {
    for (const child of row.children) {
      if (child === row.mod || !byMod.has(child) || parentOf.has(child)) continue;
      // Cycle guard: walking up from the proposed parent must not reach the
      // child. Bounded by the row count, so a corrupt answer cannot loop.
      let at: number | undefined = row.mod;
      let cyclic = false;
      for (let guard = 0; at !== undefined && guard <= byMod.size; guard++) {
        if (at === child) { cyclic = true; break; }
        at = parentOf.get(at);
      }
      if (!cyclic) parentOf.set(child, row.mod);
    }
  }
  const build = (mod: number, depth: number): ScreenNode => {
    const row = byMod.get(mod)!;
    const kids = row.children
      .filter((c) => byMod.has(c) && parentOf.get(c) === mod)
      .sort((a, b) => (byMod.get(a)!.label).localeCompare(byMod.get(b)!.label) || a - b)
      .map((c) => build(c, depth + 1));
    return { row, depth, children: kids, navigatesTo: row.navigatesTo.filter((e) => byMod.has(e.mod) && e.mod !== mod) };
  };
  return [...byMod.values()]
    .filter((r) => !parentOf.has(r.mod))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "navigator" ? -1 : 1) || a.label.localeCompare(b.label) || a.mod - b.mod)
    .map((r) => build(r.mod, 0));
}

/** Pre-order walk of the forest — the order the tree rows appear in. */
export function screenOrder(nodes: readonly ScreenNode[]): readonly ScreenNode[] {
  const out: ScreenNode[] = [];
  const walk = (n: ScreenNode): void => {
    out.push(n);
    for (const c of n.children) walk(c);
  };
  for (const n of nodes) walk(n);
  return out;
}

/** `mod -> tree depth`, for the left pane's indentation (module rows sit at
 *  depth 1 in the flattened tree, so a root screen keeps depth 1). */
export function screenDepths(nodes: readonly ScreenNode[]): ReadonlyMap<number, number> {
  const out = new Map<number, number>();
  for (const n of screenOrder(nodes)) out.set(n.row.mod, n.depth + 1);
  return out;
}

/** `mod -> its (filtered) navigation edges`. */
export function screenEdges(nodes: readonly ScreenNode[]): ReadonlyMap<number, readonly ScreenNavEdge[]> {
  const out = new Map<number, readonly ScreenNavEdge[]>();
  for (const n of screenOrder(nodes)) if (n.navigatesTo.length > 0) out.set(n.row.mod, n.navigatesTo);
  return out;
}

/** Re-sorts the Screens/Navigation groups' modules into hierarchy order
 *  (parents immediately before their children); every other group, and any
 *  module the screens answer does not cover, is left exactly where
 *  `groupModulesSegregated` put it — after the ordered ones. */
export function orderScreenGroups(groups: readonly ModuleGroup[], nodes: readonly ScreenNode[]): readonly ModuleGroup[] {
  const rank = new Map<number, number>();
  screenOrder(nodes).forEach((n, i) => rank.set(n.row.mod, i));
  if (rank.size === 0) return groups;
  const rankOf = (m: ModuleEntry): number => rank.get(m.id) ?? Number.MAX_SAFE_INTEGER;
  return groups.map((g) => {
    if (g.key !== SCREENS_KEY && g.key !== NAVIGATION_KEY) return g;
    return { ...g, modules: [...g.modules].sort((a, b) => rankOf(a) - rankOf(b) || a.id - b.id) };
  });
}
