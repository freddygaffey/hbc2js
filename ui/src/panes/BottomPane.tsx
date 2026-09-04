// ui/src/panes/BottomPane.tsx — activity/log. Collapsed to a status line by
// default (spec 22's layout diagram); expanded it shows two tabs, "Activity"
// (a friendly live feed, ui/src/activity/ActivityFeed.tsx) and "Log" (raw
// rows, ui/src/activity/LogTab.tsx). Live data is `useLog` (ui/src/hooks.ts):
// SSE (`GET /api/events`) preferred, 1 s polling of `/api/log/tail` as the
// fallback. Collapsed state and active tab persist to localStorage
// (ui/src/activity/store.ts).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ToolButton } from "../components/primitives.tsx";
import { useLog } from "../hooks.ts";
import { USING_MOCK } from "../api.ts";
import { ActivityFeed } from "../activity/ActivityFeed.tsx";
import { LogTab } from "../activity/LogTab.tsx";
import { formatTime, summarize } from "../activity/format.ts";
import { loadActiveTab, loadCollapsed, saveActiveTab, saveCollapsed, type ActivityTab } from "../activity/store.ts";

function connectionLabel(connected: "sse" | "poll" | "connecting"): string {
  if (USING_MOCK) return "mock adapter";
  return connected === "sse" ? "live" : connected === "poll" ? "polling" : "connecting…";
}

export function BottomPane(): ReactNode {
  const [open, setOpen] = useState<boolean>(() => !loadCollapsed());
  const [tab, setTab] = useState<ActivityTab>(loadActiveTab);
  const [unread, setUnread] = useState(0);
  const log = useLog();
  const rows = log.rows;
  const latest = rows.at(-1);

  // The pane header stays truthful about unread activity whether the
  // "Activity" tab is mounted or not: `seenSeqRef` is the single source of
  // truth, updated either by `ActivityFeed` (when it is showing) or by this
  // effect (when the pane is collapsed, or "Log" is the active tab).
  const seenSeqRef = useRef(0);
  const feedLive = open && tab === "activity";
  useEffect(() => {
    if (feedLive) return; // ActivityFeed owns seenSeqRef while it is mounted.
    setUnread(rows.filter((r) => r.seq > seenSeqRef.current).length);
  }, [rows, feedLive]);

  const onSeenChange = (n: number, seenSeq: number): void => {
    seenSeqRef.current = seenSeq;
    setUnread(n);
  };

  const toggleOpen = (): void => {
    const next = !open;
    setOpen(next);
    saveCollapsed(!next);
  };

  const chooseTab = (t: ActivityTab): void => {
    setTab(t);
    saveActiveTab(t);
    if (t === "log") seenSeqRef.current = rows.at(-1)?.seq ?? seenSeqRef.current;
  };

  return (
    <footer className="flex shrink-0 flex-col border-t border-border bg-surface">
      <div className="flex h-8 items-center gap-2 px-2 text-xs text-text-muted">
        <ToolButton tip={open ? "Collapse activity pane" : "Expand activity pane"} onClick={toggleOpen}>
          {open ? "▾" : "▸"} activity
          {unread > 0 && (
            <span className="ml-1 rounded-ui bg-accent px-1 text-[10px] leading-4 text-accent-fg" data-testid="activity-unread">
              {unread}
            </span>
          )}
        </ToolButton>
        <span className="truncate font-mono">
          {latest === undefined ? "no activity" : `${formatTime(latest.ts)} ${latest.who} — ${summarize(latest)}`}
        </span>
        <span className="ml-auto shrink-0">{connectionLabel(log.connected)} · {rows.length} rows in view</span>
      </div>
      {open && (
        <div className="border-t border-border">
          <div className="flex h-7 items-center gap-1 border-b border-border px-2">
            <ToolButton tip="Friendly live feed" active={tab === "activity"} onClick={() => chooseTab("activity")}>
              Activity
            </ToolButton>
            <ToolButton tip="Raw log rows" active={tab === "log"} onClick={() => chooseTab("log")}>
              Log
            </ToolButton>
          </div>
          {tab === "activity"
            ? <ActivityFeed rows={rows} initialSeenSeq={seenSeqRef.current} onSeenChange={onSeenChange} />
            : <LogTab rows={rows} />}
        </div>
      )}
    </footer>
  );
}
