// ui/src/activity/ActivityFeed.tsx — the "Activity" tab of the bottom pane:
// one compact line per log row (time, who, op, human summary), newest at
// the bottom, auto-scrolling unless the viewer has scrolled up. Clicking a
// row whose detail names a function selects it (`ui/src/state/selection.ts`).
import { useEffect, useRef, type ReactNode } from "react";
import type { LogEntry } from "../contracts.ts";
import { select } from "../state/selection.ts";
import { formatTime, summarize, targetFn } from "./format.ts";

/** How close to the bottom (px) still counts as "at the bottom" — a exact
 *  `=== 0` check would fight sub-pixel scroll rounding. */
const BOTTOM_SLOP_PX = 24;

function isAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLOP_PX;
}

function Line({ row }: { readonly row: LogEntry }): ReactNode {
  const fn = targetFn(row);
  const body = (
    <>
      <span className="text-text-muted">{formatTime(row.ts)}</span>{" "}
      <span className="text-text">{row.who}</span>{" "}
      <span className="text-text-muted">{row.op}</span>{" "}
      <span className="text-text">{summarize(row)}</span>
    </>
  );
  if (fn === null) {
    return <div className="px-2 py-0.5 font-mono text-xs">{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={() => select({ kind: "fn", fn })}
      className="block w-full px-2 py-0.5 text-left font-mono text-xs hover:bg-surface-2"
      title={`select fn ${fn}`}
    >
      {body}
    </button>
  );
}

export function ActivityFeed({
  rows, initialSeenSeq, onSeenChange,
}: {
  readonly rows: readonly LogEntry[];
  /** The highest `seq` the pane header already accounted for (e.g. from
   *  before the pane was opened, or before the "Activity" tab was chosen) —
   *  seeds this view's own notion of "seen" so re-opening does not flash a
   *  stale unread count. */
  readonly initialSeenSeq: number;
  /** Fires with `(unreadCount, seenSeq)` on every change, so the header can
   *  keep showing a correct badge even while this view is unmounted
   *  (collapsed pane, or the "Log" tab active). */
  readonly onSeenChange: (unread: number, seenSeq: number) => void;
}): ReactNode {
  const scroller = useRef<HTMLDivElement | null>(null);
  const autoScroll = useRef(true);
  const lastSeenSeq = useRef(initialSeenSeq);

  // New rows: if the viewer was pinned to the bottom, stay pinned (and mark
  // everything as seen); otherwise leave the scroll position alone and let
  // the unread count grow.
  useEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    if (autoScroll.current) {
      el.scrollTop = el.scrollHeight;
      lastSeenSeq.current = rows.at(-1)?.seq ?? lastSeenSeq.current;
    }
    const unread = rows.filter((r) => r.seq > lastSeenSeq.current).length;
    onSeenChange(unread, lastSeenSeq.current);
  }, [rows, onSeenChange]);

  const onScroll = (): void => {
    const el = scroller.current;
    if (el === null) return;
    const atBottom = isAtBottom(el);
    autoScroll.current = atBottom;
    if (atBottom) {
      lastSeenSeq.current = rows.at(-1)?.seq ?? lastSeenSeq.current;
      onSeenChange(0, lastSeenSeq.current);
    }
  };

  return (
    <div ref={scroller} onScroll={onScroll} className="hbc-scroll h-40 overflow-auto py-1">
      {rows.length === 0 && <div className="px-2 py-1 text-xs text-text-muted">no activity yet</div>}
      {rows.map((r) => <Line key={r.seq} row={r} />)}
    </div>
  );
}
