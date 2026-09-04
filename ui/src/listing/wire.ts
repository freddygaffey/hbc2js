// ui/src/listing/wire.ts — the two whole-catalogue list shapes spec 22 §3.5
// gives to `src/ui-server/list.ts` rather than to `McpResources`
// (`/api/modules`, `/api/functions?cursor=`). They live here, not in
// ui/src/contracts.ts, because contracts.ts mirrors `McpResources` only;
// these mirror `ModuleListResult` / `FunctionListPage` in
// src/ui-server/list.ts (and `ModuleEntry` in src/artifact/schema.ts).
// Structural copies, never imports: ui/ is a separate package.
import { API_BASE, USING_MOCK } from "../api.ts";

/** `ModuleEntry` — src/artifact/schema.ts. */
export interface ModuleEntry {
  readonly id: number;
  readonly file: string;
  readonly factoryFn: number | null;
  readonly deps: readonly number[];
  readonly segment: number;
}

/** `GET /api/modules` — `listModules`, capped at 500 modules server-side. */
export interface ModuleListPage {
  readonly rows: readonly ModuleEntry[];
  readonly total: number;
  readonly truncated: boolean;
}

/** `FunctionListRow` — src/ui-server/list.ts. */
export interface FunctionListRow {
  readonly fn: number;
  readonly name: string | null;
  readonly size: number | null;
  readonly module: number | null;
}

/** `GET /api/functions?cursor=` — 50 rows a page, `nextCursor` null at the end. */
export interface FunctionListPage {
  readonly rows: readonly FunctionListRow[];
  readonly total: number;
  readonly truncated: boolean;
  readonly nextCursor: number | null;
}

// -- GET /api/segregation (src/ui-server/segregation.ts) ---------------------
// The name-recovered module tree. A real Metro bundle has no module paths at
// all, so `ModuleEntry.file` cannot group the tree; these rows can.

/** `SegregationRow` — src/ui-server/segregation.ts. */
export interface SegregationRow {
  readonly id: number;
  /** Path in the segregated tree, posix separators, e.g.
   *  `"src/screens/HomeScreen.js"`, `"_unclassified/module_41.js"`. */
  readonly path: string;
  readonly bucket: "src" | "node_modules" | "unclassified";
  readonly package: string | null;
  readonly nameSignal: string | null;
  readonly nameConfidence: number | null;
}

/** `SegregationResult` — src/ui-server/segregation.ts. Counts are disjoint. */
export interface SegregationPage {
  readonly modules: readonly SegregationRow[];
  readonly counts: {
    readonly screens: number;
    readonly navigation: number;
    readonly src: number;
    readonly node_modules: number;
    readonly unclassified: number;
  };
}

/** Fetches `/api/segregation`, or `null` when it is not available — the mock
 *  adapter has no segregation to offer, and an older server (or a project
 *  with no module files) answers 404. `null` means "fall back to
 *  `groupModules`", never "show an empty tree", so this resolves rather than
 *  rejecting on every failure mode. */
export async function fetchSegregation(): Promise<SegregationPage | null> {
  if (USING_MOCK) return null;
  try {
    const res = await fetch(new URL("/api/segregation", API_BASE), { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as SegregationPage;
  } catch {
    return null;
  }
}
