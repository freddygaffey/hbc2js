// ui/src/listing/wire.ts — the two whole-catalogue list shapes spec 22 §3.5
// gives to `src/ui-server/list.ts` rather than to `McpResources`
// (`/api/modules`, `/api/functions?cursor=`). They live here, not in
// ui/src/contracts.ts, because contracts.ts mirrors `McpResources` only;
// these mirror `ModuleListResult` / `FunctionListPage` in
// src/ui-server/list.ts (and `ModuleEntry` in src/artifact/schema.ts).
// Structural copies, never imports: ui/ is a separate package.

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
