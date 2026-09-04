// ui/src/panes/BottomPane.tsx — activity/log. Collapsed to a status line by
// default; expanded it tails the append-only log (spec 22 §1's 1 s poll,
// wired through useLog — mock rows until src/ui-server lands).
import { useState, type ReactNode } from "react";
import { ToolButton } from "../components/primitives.tsx";
import { useLog } from "../hooks.ts";
import { USING_MOCK } from "../api.ts";

export function BottomPane(): ReactNode {
  const [open, setOpen] = useState(false);
  const log = useLog();
  // /api/log/tail returns oldest-first; the pane reads newest-first.
  const rows = [...(log.data?.rows ?? [])].reverse();
  const latest = rows[0];
  return (
    <footer className="flex shrink-0 flex-col border-t border-border bg-surface">
      <div className="flex h-7 items-center gap-2 px-2 text-xs text-text-muted">
        <ToolButton tip={open ? "Collapse activity log" : "Expand activity log"} onClick={() => setOpen(!open)}>
          {open ? "v" : "^"} activity
        </ToolButton>
        <span className="truncate font-mono">
          {latest === undefined ? "no activity" : `${latest.op} · ${latest.detail ?? ""}`}
        </span>
        <span className="ml-auto">{USING_MOCK ? "mock adapter" : "connected"} · {rows.length} log rows</span>
      </div>
      {open && (
        <div className="hbc-scroll h-40 overflow-auto border-t border-border px-2 py-1">
          {rows.map((r) => (
            <div key={r.seq} className="font-mono text-xs text-text">
              <span className="text-text-muted">{r.ts}</span> {r.who} {r.op}{" "}
              <span className="text-text-muted">{r.detail ?? ""}</span>
            </div>
          ))}
        </div>
      )}
    </footer>
  );
}
