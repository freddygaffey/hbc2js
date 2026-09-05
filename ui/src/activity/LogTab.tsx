// ui/src/activity/LogTab.tsx — the "Log" tab of the bottom pane: raw rows
// (seq, ts, who, op, detail verbatim), monospace, filterable by who/op,
// sortable by any column and virtualised (spec 26 L5's shared
// `ResultTable`) so a long-running session's log never re-mounts every row
// on each new entry.
import { useMemo, useState, type ReactNode } from "react";
import { ResultTable, type ColumnDef } from "../components/ResultTable.tsx";
import type { LogEntry } from "../contracts.ts";

function matches(row: LogEntry, needle: string): boolean {
  if (needle === "") return true;
  const n = needle.toLowerCase();
  return row.who.toLowerCase().includes(n) || row.op.toLowerCase().includes(n);
}

const cell = (v: unknown): ReactNode => <span>{v as string}</span>;

const COLUMNS: ColumnDef<LogEntry, any>[] = [
  { id: "seq", header: "#", accessorFn: (r) => r.seq, cell: (info) => <span className="text-text-muted">{info.getValue() as number}</span> },
  { id: "ts", header: "time", accessorFn: (r) => r.ts, cell: (info) => cell(info.getValue()) },
  { id: "who", header: "who", accessorFn: (r) => r.who, cell: (info) => cell(info.getValue()) },
  { id: "op", header: "op", accessorFn: (r) => r.op, cell: (info) => cell(info.getValue()) },
  { id: "detail", header: "detail", accessorFn: (r) => r.detail ?? "", cell: (info) => <span className="text-text-muted">{info.getValue() as string}</span> },
];

export function LogTab({ rows }: { readonly rows: readonly LogEntry[] }): ReactNode {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => rows.filter((r) => matches(r, filter.trim())), [rows, filter]);

  return (
    <div className="flex h-40 flex-col">
      <div className="shrink-0 border-b border-border px-2 py-1">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter by who or op"
          aria-label="filter log by who or op"
          className="h-6 w-64 rounded-ui border border-border bg-surface-2 px-2 text-xs text-text outline-none placeholder:text-text-muted focus-visible:border-accent"
        />
        <span className="ml-2 text-xs text-text-muted">{filtered.length} / {rows.length} rows</span>
      </div>
      <div className="min-h-0 flex-1 font-mono text-xs">
        <ResultTable data={filtered} getRowId={(r) => String(r.seq)} emptyMessage="no matching rows" columns={COLUMNS} />
      </div>
    </div>
  );
}
