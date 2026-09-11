// ui/src/panes/WorkersPane.tsx — spec 23 §6's UI surface, as the right
// pane's third tab: the jobs rail, presence ("who is here"), and the
// accept/reject list for the selected function's suggestions.
//
// The whole point of the pane is that AI output is VISIBLY a proposal:
// every suggestion row says who proposed it and which job run produced it,
// and the name only becomes truth when a human presses Accept (spec 23 §4 —
// promotion carries the HUMAN's provenance, never the worker's). Reject
// writes nothing: the suggestion stays as history, greyed.
import { useState, type ReactNode } from "react";
import { Empty, ToolButton } from "../components/primitives.tsx";
import { ResultTable } from "../components/ResultTable.tsx";
import { useSelection } from "../state/selection.ts";
import { setStatus } from "../actions/store.ts";
import { invalidateFn } from "../actions/registry.ts";
import { useCancelJob, useEnqueue, useJobs, usePromote, useReject, useSessions, useSuggestions } from "../workers/hooks.ts";
import { WorkersUnavailable, type JobRow, type JobStatus, type SessionRow, type SuggestionRow } from "../workers/wire.ts";
import {
  useCombineFilesAction,
  useReadabilitySuggestions,
  useReviewAction,
  useRewriteFunctionAction,
  useRevertSuggestion,
  useSuggestNamesAction,
  usePromoteSuggestion as usePromoteReadabilitySuggestion,
} from "../workers/readability-hooks.ts";
import {
  ReadabilityUnavailable,
  type ReadabilityFilter,
  type ReadabilitySuggestionRow,
  type SuggestionConfidence,
  type SuggestionTier,
} from "../workers/readability-wire.ts";

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
  if (e instanceof ReadabilityUnavailable) return e.message;
  return e instanceof Error ? e.message : String(e);
}

// -- spec 28 landing 4c: the readability suggestion pane -------------------
//
// A DIFFERENT pipeline from the jobs/suggestions section above (this file's
// own header note on ./workers/wire.ts vs ./workers/readability-wire.ts):
// names/rewrites/file-ops here go through the overlay + transaction log
// (src/readability/surfaces.ts), never the `[ai-suggested]` annotation
// convention the jobs rail uses.

/** Reach ordering (spec 28 §1d: "highest-reach first"). No caller-count
 *  (xref) data reaches this pane yet, so the fallback the brief names
 *  applies: module order (a name row's own `bindingId.fn` is the nearest
 *  proxy for names, since a name has no module field at all). Ascending —
 *  module 0 / the earliest functions are treated as "highest reach" (entry
 *  code), matching the fallback's own module-order framing. */
function reachKey(row: ReadabilitySuggestionRow): number {
  if (row.kind === "name") return row.bindingId.fn;
  return row.tx.inputs[0]?.module ?? Number.POSITIVE_INFINITY;
}

function sortByReach(rows: readonly ReadabilitySuggestionRow[]): readonly ReadabilitySuggestionRow[] {
  return [...rows].sort((a, b) => reachKey(a) - reachKey(b));
}

function rowId(row: ReadabilitySuggestionRow): string {
  return row.kind === "name" ? row.suggestionId : row.tx.id;
}

function rowIdArgs(row: ReadabilitySuggestionRow): { readonly txId?: string; readonly suggestionId?: string } {
  return row.kind === "name" ? { suggestionId: row.suggestionId } : { txId: row.tx.id };
}

const EQUIV_CLASS: Readonly<Record<string, string>> = {
  PASS: "text-sev-ok",
  FAIL: "text-sev-crit",
  DIVERGENT: "text-sev-crit",
  INCONCLUSIVE: "text-sev-med",
};

function EquivBadge({ row }: { readonly row: ReadabilitySuggestionRow }): ReactNode {
  if (row.kind === "name") return <span className="text-text-muted">—</span>;
  const { verdict, scope, oracle } = row.tx.equiv;
  return (
    <span className={EQUIV_CLASS[verdict] ?? "text-text-muted"} title={`scope: ${scope}\noracle: ${oracle}`}>
      {verdict}
    </span>
  );
}

function ReadabilityRowView({
  row,
  selected,
  onToggle,
  onPromote,
  onRevert,
}: {
  readonly row: ReadabilitySuggestionRow;
  readonly selected: boolean;
  readonly onToggle: () => void;
  readonly onPromote: () => void;
  readonly onRevert: () => void;
}): ReactNode {
  const id = rowId(row);
  const isSuggested = row.kind === "name" ? row.tier === "suggested" : row.tx.tier === "suggested";
  return (
    <div className="border-b border-border px-3 py-2 text-xs" data-testid={`readability-row-${id}`}>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label={`select suggestion ${id}`}
          checked={selected}
          onChange={onToggle}
        />
        <span className="text-text-muted">{row.kind === "name" ? "name" : row.tx.op}</span>
        {row.kind === "name" && <span className="font-mono text-text">{row.name}</span>}
        {row.kind === "name" && <span className="text-text-muted">{row.confidence}</span>}
        <EquivBadge row={row} />
        <span className="text-text-muted">{row.kind === "name" ? row.tier : row.tx.tier}</span>
        <span className="ml-auto flex gap-1">
          {isSuggested && (
            <ToolButton active onClick={onPromote} tip="promote to confirmed">
              Accept
            </ToolButton>
          )}
          <ToolButton onClick={onRevert} tip="one-click undo (spec 28 §1d)">
            Revert
          </ToolButton>
        </span>
      </div>
      <div className="pt-1 text-text-muted">{row.kind === "name" ? row.evidence : row.tx.evidence}</div>
      {row.kind === "tx" && row.tx.op === "rewrite" && (
        <div className="mt-1 grid grid-cols-2 gap-2 rounded-ui bg-surface-2 p-2 font-mono text-[11px]" data-testid={`readability-diff-${id}`}>
          <div>
            <div className="text-text-muted">before (prior)</div>
            {row.tx.prior.files.map((f) => (
              <div key={f.path} className="truncate text-text-muted" title={f.sha256}>
                {f.path}
              </div>
            ))}
          </div>
          <div>
            <div className="text-text-muted">after (output)</div>
            {row.tx.outputs.map((f) => (
              <div key={f.path} className="truncate text-text">
                {f.path}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const TIER_OPTIONS: readonly SuggestionTier[] = ["suggested", "confirmed"];
const CONFIDENCE_OPTIONS: readonly SuggestionConfidence[] = ["low", "med", "high"];

function ReadabilitySection({ fn, moduleId }: { readonly fn: number | undefined; readonly moduleId: string | undefined }): ReactNode {
  const [tier, setTier] = useState<SuggestionTier | "">("");
  const [confidence, setConfidence] = useState<SuggestionConfidence | "">("");
  const [moduleFilter, setModuleFilter] = useState("");
  const [securityRelevant, setSecurityRelevant] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [combineOpen, setCombineOpen] = useState(false);
  const [combineInputs, setCombineInputs] = useState("");
  const [combineOutput, setCombineOutput] = useState("");
  const [combineEvidence, setCombineEvidence] = useState("");

  const filter: ReadabilityFilter = {
    ...(tier !== "" ? { tier } : {}),
    ...(confidence !== "" ? { confidence } : {}),
    ...(moduleFilter !== "" && Number.isInteger(Number(moduleFilter)) ? { module: Number(moduleFilter) } : {}),
    ...(securityRelevant ? { securityRelevant: true } : {}),
  };

  const suggestions = useReadabilitySuggestions(filter);
  const promote = usePromoteReadabilitySuggestion();
  const revert = useRevertSuggestion();
  const suggestNamesAction = useSuggestNamesAction();
  const rewriteAction = useRewriteFunctionAction();
  const combineAction = useCombineFilesAction();
  const reviewAction = useReviewAction();

  const off = suggestions.error instanceof ReadabilityUnavailable;
  const rows = sortByReach(suggestions.data?.suggestions ?? []);

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const doPromote = (row: ReadabilitySuggestionRow): void => {
    promote.mutate(
      { id: rowIdArgs(row), who: "ui" },
      { onSuccess: () => setStatus(`promoted ${rowId(row)} to confirmed`), onError: (e) => setStatus(errorLine(e)) },
    );
  };
  const doRevert = (row: ReadabilitySuggestionRow): void => {
    revert.mutate(rowIdArgs(row), { onSuccess: () => setStatus(`reverted ${rowId(row)}`), onError: (e) => setStatus(errorLine(e)) });
  };

  const batchPromote = (): void => {
    for (const row of rows) if (selected.has(rowId(row))) doPromote(row);
  };
  const batchRevert = (): void => {
    for (const row of rows) if (selected.has(rowId(row))) doRevert(row);
  };

  const targetModule = moduleId !== undefined && Number.isInteger(Number(moduleId)) ? Number(moduleId) : undefined;

  return (
    <div className="border-t border-border">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-text">Readability</span>
        <select
          aria-label="tier filter"
          className="rounded-ui bg-surface-2 px-1 py-0.5 text-xs text-text"
          value={tier}
          onChange={(e) => setTier(e.target.value as SuggestionTier | "")}
        >
          <option value="">tier: any</option>
          {TIER_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          aria-label="confidence filter"
          className="rounded-ui bg-surface-2 px-1 py-0.5 text-xs text-text"
          value={confidence}
          onChange={(e) => setConfidence(e.target.value as SuggestionConfidence | "")}
        >
          <option value="">confidence: any</option>
          {CONFIDENCE_OPTIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          aria-label="module filter"
          className="w-16 rounded-ui bg-surface-2 px-1 py-0.5 text-xs text-text"
          placeholder="module"
          value={moduleFilter}
          onChange={(e) => setModuleFilter(e.target.value)}
        />
        <label className="flex items-center gap-1 text-xs text-text-muted">
          <input type="checkbox" checked={securityRelevant} onChange={(e) => setSecurityRelevant(e.target.checked)} />
          security-relevant
        </label>
        <ToolButton
          active={!off}
          onClick={() =>
            reviewAction.mutate(undefined, {
              onSuccess: (r) => setStatus(`review: ${r.pending} suggestion(s) pending`),
              onError: (e) => setStatus(errorLine(e)),
            })
          }
          tip="review suggestions (spec 28 §9.7)"
        >
          Review
        </ToolButton>
        <ToolButton
          active={!off}
          onClick={() =>
            suggestNamesAction.mutate(fn !== undefined ? { fn } : { module: targetModule ?? 0 }, {
              onSuccess: () => setStatus("suggest names: done"),
              onError: (e) => setStatus(errorLine(e)),
            })
          }
          tip="suggest names for this module"
        >
          Suggest names
        </ToolButton>
        {fn !== undefined && (
          <ToolButton
            active={!off}
            onClick={() =>
              rewriteAction.mutate(fn, {
                onSuccess: (r) => setStatus(r.accepted ? "make readable: accepted" : "make readable: refused by the equivalence gate"),
                onError: (e) => setStatus(errorLine(e)),
              })
            }
            tip="make this function readable"
          >
            Make readable
          </ToolButton>
        )}
        <ToolButton active={!off} onClick={() => setCombineOpen((v) => !v)} tip="combine these files">
          Combine files
        </ToolButton>
        <span className="ml-auto flex gap-1">
          <ToolButton onClick={batchPromote} tip="promote every selected suggestion">
            Promote selected
          </ToolButton>
          <ToolButton onClick={batchRevert} tip="revert every selected suggestion">
            Revert selected
          </ToolButton>
        </span>
      </div>

      {combineOpen && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
          <input
            aria-label="combine inputs (comma-separated paths)"
            className="w-56 rounded-ui bg-surface-2 px-1 py-0.5 text-text"
            placeholder="src/a.js, src/b.js"
            value={combineInputs}
            onChange={(e) => setCombineInputs(e.target.value)}
          />
          <input
            aria-label="combine output path"
            className="w-40 rounded-ui bg-surface-2 px-1 py-0.5 text-text"
            placeholder="combined.js"
            value={combineOutput}
            onChange={(e) => setCombineOutput(e.target.value)}
          />
          <input
            aria-label="combine evidence"
            className="w-56 rounded-ui bg-surface-2 px-1 py-0.5 text-text"
            placeholder="evidence"
            value={combineEvidence}
            onChange={(e) => setCombineEvidence(e.target.value)}
          />
          <ToolButton
            active
            onClick={() => {
              const inputs = combineInputs.split(",").map((s) => s.trim()).filter((s) => s !== "");
              combineAction.mutate(
                { inputs, outputs: [combineOutput], evidence: combineEvidence },
                { onSuccess: () => setStatus("combine files: accepted"), onError: (e) => setStatus(errorLine(e)) },
              );
            }}
            tip="run the combine file-op"
          >
            Run
          </ToolButton>
        </div>
      )}

      {off ? (
        <Empty>{errorLine(suggestions.error)}</Empty>
      ) : rows.length === 0 ? (
        <Empty>No readability suggestions match this filter.</Empty>
      ) : (
        <div className="hbc-scroll min-h-0 max-h-64 overflow-auto">
          {rows.map((row) => (
            <ReadabilityRowView
              key={rowId(row)}
              row={row}
              selected={selected.has(rowId(row))}
              onToggle={() => toggle(rowId(row))}
              onPromote={() => doPromote(row)}
              onRevert={() => doRevert(row)}
            />
          ))}
        </div>
      )}
    </div>
  );
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

          <ReadabilitySection fn={hasTarget ? target : undefined} moduleId={selection.moduleId} />
        </div>
      )}
    </div>
  );
}
