// ui/src/panes/WorkersPane.tsx — spec 23 §6's UI surface, as the right
// pane's third tab: the jobs rail, presence ("who is here"), and the
// accept/reject list for the selected function's suggestions.
//
// The whole point of the pane is that AI output is VISIBLY a proposal:
// every suggestion row says who proposed it and which job run produced it,
// and the name only becomes truth when a human presses Accept (spec 23 §4 —
// promotion carries the HUMAN's provenance, never the worker's). Reject
// writes nothing: the suggestion stays as history, greyed.
import type { ReactNode } from "react";
import { Empty, ToolButton } from "../components/primitives.tsx";
import { ResultTable } from "../components/ResultTable.tsx";
import { useSelection } from "../state/selection.ts";
import { setStatus } from "../actions/store.ts";
import { invalidateFn } from "../actions/registry.ts";
import { useCancelJob, useEnqueue, useJobs, usePromote, useReject, useSessions, useSuggestions } from "../workers/hooks.ts";
import { WorkersUnavailable, type JobRow, type JobStatus, type SessionRow, type SuggestionRow } from "../workers/wire.ts";

const STATUS_CLASS: Readonly<Record<JobStatus, string>> = {
  queued: "text-text-muted",
  running: "text-sev-med",
  done: "text-sev-ok",
  failed: "text-sev-crit",
  cancelled: "text-text-muted",
};

function elapsed(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Initials for a presence chip: `worker:heuristic` -> `HE`, an email ->
 *  the first two letters of the local part. */
function initials(who: string): string {
  const base = who.includes(":") ? who.slice(who.indexOf(":") + 1) : who.split("@")[0] ?? who;
  return base.slice(0, 2).toUpperCase();
}

function SessionChip({ s }: { readonly s: SessionRow }): ReactNode {
  return (
    <span
      className="flex items-center gap-1 rounded-ui bg-surface-2 px-2 py-0.5 text-xs text-text"
      title={`${s.kind} · ${s.who} · last seen ${s.lastSeen}`}
    >
      <span className="font-mono text-text-muted">{initials(s.who)}</span>
      <span className="truncate">{s.who}</span>
    </span>
  );
}

function SuggestionRowView({
  row,
  onAccept,
  onReject,
}: {
  readonly row: SuggestionRow;
  readonly onAccept: (row: SuggestionRow) => void;
  readonly onReject: (row: SuggestionRow) => void;
}): ReactNode {
  return (
    <div className={`border-b border-border px-3 py-2 text-xs ${row.rejected ? "opacity-50" : ""}`}>
      <div className="flex items-center gap-2">
        <span className="text-text-muted">{row.kind === "name" ? "name" : "note"}</span>
        <span className="text-text-muted" title={row.run === null ? "no job recorded" : `job ${row.run}`}>
          {row.who}
        </span>
        {row.rejected && <span className="text-text-muted">rejected</span>}
        <span className="ml-auto flex gap-1">
          {row.kind === "name" && !row.rejected && (
            <ToolButton active onClick={() => onAccept(row)} tip="promote to the name slot">
              Accept
            </ToolButton>
          )}
          {!row.rejected && (
            <ToolButton onClick={() => onReject(row)} tip="writes nothing; keeps the suggestion as history">
              Reject
            </ToolButton>
          )}
        </span>
      </div>
      <div className={`pt-1 ${row.kind === "name" ? "font-mono" : ""} text-text`}>{row.text}</div>
    </div>
  );
}

function errorLine(e: unknown): string {
  if (e instanceof WorkersUnavailable) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export function WorkersPane({ fn }: { readonly fn: number }): ReactNode {
  const selection = useSelection();
  const target = selection.fn ?? fn;
  const hasTarget = target >= 0;
  const jobs = useJobs();
  const sessions = useSessions();
  const suggestions = useSuggestions(hasTarget ? target : undefined);
  const enqueue = useEnqueue();
  const cancel = useCancelJob();
  const promote = usePromote();
  const reject = useReject();

  const off = jobs.error instanceof WorkersUnavailable;

  const queue = (kind: string): void => {
    enqueue.mutate(
      { kind, input: { fn: target } },
      {
        onSuccess: (r) => setStatus(r.deduped ? `${kind} for fn:${target} is already queued` : `${kind} queued for fn:${target}`),
        onError: (e) => setStatus(errorLine(e)),
      },
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ToolButton active={!off} onClick={() => queue("suggest-name")} tip="queue a suggest-name job">
          Suggest name
        </ToolButton>
        <ToolButton active={!off} onClick={() => queue("explain-fn")} tip="queue an explain job">
          Explain
        </ToolButton>
        <span className="ml-auto text-xs text-text-muted">
          {off ? "workers off" : `${jobs.data?.backend ?? "…"} · cap ${jobs.data?.concurrency ?? "?"}`}
        </span>
      </div>

      {off ? (
        <Empty>{errorLine(jobs.error)}</Empty>
      ) : (
        <div className="hbc-scroll min-h-0 flex-1 overflow-auto">
          <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2">
            <span className="pr-1 text-xs text-text-muted">here:</span>
            {(sessions.data?.rows ?? []).map((s) => <SessionChip key={s.id} s={s} />)}
            {(sessions.data?.rows ?? []).length === 0 && <span className="text-xs text-text-muted">nobody yet</span>}
          </div>

          <div className="px-3 pt-2 pb-1 text-xs text-text-muted">
            {hasTarget ? `suggestions for fn:${target}` : "suggestions (no function selected)"}
          </div>
          {(suggestions.data?.rows ?? []).length === 0 && <Empty>No suggestions yet — queue one above.</Empty>}
          {(suggestions.data?.rows ?? []).map((row) => (
            <SuggestionRowView
              key={row.rid}
              row={row}
              onAccept={(r) =>
                promote.mutate(
                  { target: r.target, rid: r.rid },
                  {
                    onSuccess: (res) => {
                      invalidateFn(r.fn ?? undefined);
                      setStatus(res.line);
                    },
                    onError: (e) => setStatus(errorLine(e)),
                  },
                )
              }
              onReject={(r) =>
                reject.mutate(r.rid, {
                  onSuccess: () => setStatus(`rejected ${r.kind} suggestion (nothing was written)`),
                  onError: (e) => setStatus(errorLine(e)),
                })
              }
            />
          ))}

          <div className="px-3 pt-3 pb-1 text-xs text-text-muted">jobs ({jobs.data?.total ?? 0})</div>
          <div className="h-64 min-h-0 shrink-0">
            <ResultTable
              data={jobs.data?.rows ?? []}
              getRowId={(job) => job.id}
              emptyMessage="No jobs queued."
              columns={[
                { id: "status", header: "status", accessorFn: (job: JobRow) => job.status, cell: (info) => <span className={STATUS_CLASS[info.getValue() as JobStatus]}>{info.getValue() as string}</span> },
                { id: "kind", header: "kind", accessorFn: (job: JobRow) => job.kind, cell: (info) => <span className="text-text">{info.getValue() as string}</span> },
                { id: "target", header: "target", accessorFn: (job: JobRow) => job.target, cell: (info) => <span className="font-mono text-text-muted">{info.getValue() as string}</span> },
                { id: "elapsed", header: "elapsed", accessorFn: (job: JobRow) => job.elapsedMs ?? -1, cell: (info) => <span className="text-text-muted">{elapsed(info.getValue() === -1 ? null : (info.getValue() as number))}</span> },
                {
                  id: "cancel",
                  header: "",
                  cell: (info) => {
                    const job = info.row.original;
                    const cancellable = job.status === "queued" || job.status === "running";
                    return cancellable ? (
                      <ToolButton
                        onClick={(e) => {
                          e.stopPropagation();
                          cancel.mutate(job.id, { onSuccess: () => setStatus(`cancelled ${job.id}`), onError: (err) => setStatus(errorLine(err)) });
                        }}
                        tip="cancel"
                      >
                        Cancel
                      </ToolButton>
                    ) : null;
                  },
                },
              ]}
            />
          </div>
        </div>
      )}
    </div>
  );
}
