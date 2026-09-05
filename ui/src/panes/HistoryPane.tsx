// ui/src/panes/HistoryPane.tsx — spec 26 L6's per-target history/audit
// view: `GET /api/history/{target}` (spec 16 §3.2), reachable from the
// context menu's "History" action (`view.history`, src/ui-core/actions.ts)
// on any function or module selection. Thin view over a tested contract
// (spec 19 §1.4): no ordering/filtering logic beyond the reversal the
// server's own doc comment calls out (`history()` answers newest-first;
// this pane's job is only to show it oldest-first, which is the natural
// reading order for "what happened to this target over time").
import type { ReactNode } from "react";
import { Modal } from "../actions/Modal.tsx";
import { Empty } from "../components/primitives.tsx";
import { useHistory } from "../hooks.ts";

export function HistoryPane({ target, onClose }: { readonly target: string; readonly onClose: () => void }): ReactNode {
  const history = useHistory(target);
  const rows = history.data?.rows ?? [];
  // Server sends newest-first (`ProjectService.history`'s own doc comment);
  // oldest-first is the natural reading order for a revision timeline.
  const oldestFirst = [...rows].reverse();
  return (
    <Modal title="History" subtitle={<>revisions on <span className="font-mono">{target}</span></>} onClose={onClose} wide>
      {history.data === undefined && <Empty>loading…</Empty>}
      {history.data !== undefined && rows.length === 0 && <Empty>no revisions recorded for this target.</Empty>}
      {oldestFirst.length > 0 && (
        <div className="hbc-scroll max-h-[60vh] overflow-auto">
          {oldestFirst.map((r) => (
            <div key={r.rid} className="flex items-center gap-2 border-b border-border px-1 py-1 text-xs">
              <span className="w-40 shrink-0 text-text-muted">{r.ts}</span>
              <span className="w-20 shrink-0 text-text">{r.kind}</span>
              <span className="text-text-muted">{r.who}</span>
              {r.cleared && <span className="ml-auto text-text-muted">cleared</span>}
              {r.reactivates !== null && <span className="ml-auto text-text-muted">reactivates #{r.reactivates}</span>}
              {r.supersedes !== null && <span className="ml-auto text-text-muted">supersedes #{r.supersedes}</span>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
