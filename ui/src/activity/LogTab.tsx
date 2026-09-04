// ui/src/activity/LogTab.tsx — the "Log" tab of the bottom pane: raw rows
// (seq, ts, who, op, detail verbatim), monospace, filterable by who/op.
import { useMemo, useState, type ReactNode } from "react";
import type { LogEntry } from "../contracts.ts";

function matches(row: LogEntry, needle: string): boolean {
  if (needle === "") return true;
  const n = needle.toLowerCase();
  return row.who.toLowerCase().includes(n) || row.op.toLowerCase().includes(n);
}

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
      <div className="hbc-scroll flex-1 overflow-auto py-1">
        {filtered.length === 0 && <div className="px-2 py-1 text-xs text-text-muted">no matching rows</div>}
        {filtered.map((r) => (
          <div key={r.seq} className="px-2 py-0.5 font-mono text-xs text-text">
            <span className="text-text-muted">#{r.seq} {r.ts}</span> {r.who} {r.op}{" "}
            <span className="text-text-muted">{r.detail ?? ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
