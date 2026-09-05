// ui/src/components/ResultTable.tsx — spec 26 L5: one shared, virtualised,
// sortable table for every result list in the shell (xrefs, search hits,
// findings, leads, strings, object tables, jobs, the log), composed from
// `@tanstack/react-table` (client-side sort — never a refetch, spec 26 L5's
// own acceptance test) + `@tanstack/react-virtual` (only the rows the
// viewport can show are ever mounted — the same discipline
// `ui/src/panes/LeftPane.tsx`'s module tree already applies) + the token
// primitives (no raw colours/px — `tests/gate/ui/tokens.test.ts`).
//
// This replaces the silent `slice(0, 100)` / `slice(0, 200)` caps that used
// to live in `LeftPane.tsx`: a capped result now always carries its own
// `cap` (shown/total/truncated), rendered by `TruncationBar` below the
// table — the same honest-truncation idiom `CenterPane.tsx`'s line view and
// spec 25 §5 already use, just for rows instead of lines.
import {
  flexRender, getCoreRowModel, getSortedRowModel, useReactTable,
  type ColumnDef, type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";

export type { ColumnDef } from "@tanstack/react-table";

/** Same measurement `LeftPane.tsx`'s `readRowHeightPx` uses: the `--row-height`
 *  CSS var is the single source of truth for row height (theme-controlled,
 *  spec 20 §1.2), `useVirtualizer`'s `estimateSize` just needs to start
 *  close to it. */
function readRowHeightPx(): number {
  if (typeof window === "undefined") return 32;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--row-height").trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 32;
}

export interface ResultCap {
  /** Rows actually rendered (after the contract's own cap was applied server-side, or none). */
  readonly shown: number;
  /** The true count the contract knows about, capped result or not. */
  readonly total: number;
  /** Whether `shown < total` — the contract's own flag, never re-derived client-side. */
  readonly truncated: boolean;
  /** What one row is called in the message ("row", "table", "string", …) — defaults to "row". */
  readonly noun?: string;
}

/** The one shown/total line every capped list in the shell renders — reads
 *  the contract's own `cap` (`RESOURCE_CAPS` on the server, mirrored here
 *  as the `shown`/`total`/`truncated` triple every paginated resource
 *  already returns), never a client-invented number. Always visible (the
 *  same "N of M rows" idiom `StringsPane.tsx`/`TablesPane.tsx`'s own
 *  `BoundedLine` used before this landing), with a `(truncated)` suffix
 *  only when the contract's own `truncated` flag is set — so a list that
 *  was never capped still gets an honest count, and a list that WAS capped
 *  says so, both from the same line. */
export function TruncationBar({ shown, total, truncated, noun = "row" }: ResultCap): ReactNode {
  return (
    <div
      data-testid="truncation-bar"
      className="flex h-6 shrink-0 items-center gap-2 border-t border-border bg-surface-2 px-3 text-xs text-text-muted"
    >
      {truncated && <span className="text-text">truncated</span>}
      <span>
        {shown.toLocaleString()} of {total.toLocaleString()} {noun}
        {total === 1 ? "" : "s"}
        {truncated && " (truncated)"}
      </span>
    </div>
  );
}

export interface ResultTableProps<T> {
  readonly data: readonly T[];
  readonly columns: ColumnDef<T, any>[];
  readonly getRowId?: (row: T, index: number) => string;
  /** Extra attributes (e.g. `data-fn`) placed on the row element itself —
   *  the DOM hook every existing e2e spec already selects rows by. */
  readonly rowProps?: (row: T) => Record<string, string | number | boolean | undefined>;
  readonly onRowClick?: (row: T) => void;
  /** `"button"` for a navigable/actionable row (keeps existing
   *  `button[data-fn=...]` e2e selectors working); `"div"` (default) for a
   *  read-only row. */
  readonly rowElement?: "div" | "button";
  readonly emptyMessage?: string;
  readonly cap?: ResultCap | undefined;
  readonly rowClassName?: (row: T) => string;
}

/** The shared table: sortable header (client-side — spec 26 L5's own
 *  acceptance test, "sorting a column reorders rows without refetching"),
 *  virtualised body (`@tanstack/react-virtual`, "10k rows scroll without
 *  mounting 10k DOM nodes"), and an optional `TruncationBar`. */
export function ResultTable<T>({
  data, columns, getRowId, rowProps, onRowClick, rowElement = "div", emptyMessage = "no results", cap, rowClassName,
}: ResultTableProps<T>): ReactNode {
  const [sorting, setSorting] = useState<SortingState>([]);
  const table = useReactTable({
    data: data as T[],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    ...(getRowId ? { getRowId } : {}),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const rows = table.getRowModel().rows;
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [rowHeightPx] = useState(readRowHeightPx);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeightPx,
    overscan: 12,
    getItemKey: (index) => rows[index]?.id ?? index,
  });

  const RowTag = rowElement;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="result-table">
      <div className="flex h-7 shrink-0 items-center border-b border-border text-xs text-text-muted">
        {table.getHeaderGroups().map((hg) =>
          hg.headers.map((header) => {
            const sorted = header.column.getIsSorted();
            return (
              <button
                key={header.id}
                type="button"
                data-column={header.column.id}
                data-testid="result-table-header"
                onClick={header.column.getToggleSortingHandler()}
                className="flex h-7 flex-1 items-center gap-1 truncate px-2 text-left outline-none hover:text-text"
              >
                {flexRender(header.column.columnDef.header, header.getContext())}
                {sorted === "asc" && <span aria-hidden>^</span>}
                {sorted === "desc" && <span aria-hidden>v</span>}
              </button>
            );
          }),
        )}
      </div>
      {rows.length === 0 ? (
        <div className="p-3 text-xs text-text-muted">{emptyMessage}</div>
      ) : (
        <div ref={parentRef} className="hbc-scroll min-h-0 flex-1 overflow-auto">
          <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]!;
              const style: CSSProperties = {
                position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)`,
              };
              return (
                <RowTag
                  key={item.key}
                  data-index={item.index}
                  style={style}
                  {...(rowElement === "button" ? { type: "button" as const } : {})}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  className={`flex h-[var(--row-height)] w-full cursor-default items-center gap-2 border-b border-border px-2 text-left text-xs text-text hover:bg-surface-2 ${rowClassName ? rowClassName(row.original) : ""}`}
                  {...(rowProps ? rowProps(row.original) : {})}
                >
                  {row.getVisibleCells().map((cell) => (
                    <div key={cell.id} className="min-w-0 flex-1 truncate">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
                </RowTag>
              );
            })}
          </div>
        </div>
      )}
      {cap && <TruncationBar {...cap} />}
    </div>
  );
}
