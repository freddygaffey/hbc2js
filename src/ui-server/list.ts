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

/** Every module the artifact knows about — own cap (never widens anything
 *  `resources.ts` publishes; this is a new list this layer owns). */
const CAP_MODULES = 500;

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

/** `/api/functions?cursor=` — every function `{fn, name, size, module}`,
 *  paged like `search/functions` (`src/mcp/leads.ts`'s `paginate`) but with
 *  no name filter; same page size so the two feel consistent in the UI. */
const FUNCTIONS_PAGE_CAP = 50;

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

export function listFunctions(artifact: ArtifactService, cursor = 0): FunctionListPage {
  const all = artifact.listFns();
  const start = Math.max(0, cursor);
  const page = all.slice(start, start + FUNCTIONS_PAGE_CAP);
  const rows: FunctionListRow[] = page.map(({ fn }) => {
    const s: FnSummary = artifact.fn(fn);
    const size = s.lines !== null ? s.lines[1] - s.lines[0] + 1 : null;
    return { fn, name: s.overlayName ?? s.name, size, module: s.module };
  });
  const nextCursor = start + rows.length < all.length ? start + rows.length : null;
  return { rows, total: all.length, truncated: all.length > FUNCTIONS_PAGE_CAP, nextCursor };
}
