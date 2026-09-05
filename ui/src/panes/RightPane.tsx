// ui/src/panes/RightPane.tsx — ONE panel visible at a time (spec 22 §2):
// Context / Xrefs / Findings / Package.
import * as Tabs from "@radix-ui/react-tabs";
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Empty, PaneHeader, ToolButton } from "../components/primitives.tsx";
import { ResultTable, type ColumnDef } from "../components/ResultTable.tsx";
import { useCallsFrom, useContextResource, useFindings, usePackageId, useWhoCalls, useWhoCallsByName } from "../hooks.ts";
import { useSegregation } from "../listing/use-segregation.ts";
import type { ByNameCaller, FindingStatus, ResolvedFinding, Severity, XrefEdge } from "../contracts.ts";
import { displayName } from "../actions/names.ts";
import { openDialog, setRightPanel, useActionsState, type RightPanel } from "../actions/store.ts";
import { keymap } from "../actions/registry.ts";
import { select, useSelection } from "../state/selection.ts";
import { ToolError, setFindingStatus } from "../actions/writes.ts";
import { WorkersPane } from "./WorkersPane.tsx";
import { StringsPane } from "./StringsPane.tsx";
import { TablesPane } from "./TablesPane.tsx";
import { GraphPane } from "../graph/GraphPane.tsx";
import { EditPane } from "./EditPane.tsx";

const tabClass =
  "h-7 flex-1 rounded-ui px-2 text-xs text-text-muted outline-none data-[state=active]:bg-surface-2 data-[state=active]:text-text";
const bodyClass = "hbc-scroll min-h-0 flex-1 overflow-auto outline-none";

const SEVERITY_CLASS: Readonly<Record<Severity, string>> = {
  critical: "text-sev-crit",
  high: "text-sev-high",
  med: "text-sev-med",
  low: "text-sev-ok",
};

/** Columns shared by the "called by" / "calls" tables: clicking a row
 *  selects that function, which is what makes the Xrefs panel a navigation
 *  surface rather than a list of numbers. `NeighborRef.fn` is `number |
 *  string` (a native/unknown neighbour has no fn index) — only a numeric
 *  one is navigable, so a non-numeric row renders but does not click. */
const XREF_COLUMNS: ColumnDef<XrefEdge, any>[] = [
  { id: "name", header: "name", accessorFn: (e) => e.name ?? String(e.fn), cell: (info) => <span className="font-mono">{info.getValue() as string}</span> },
  { id: "loc", header: "location", accessorFn: (e) => `${e.file}:${e.line}`, cell: (info) => <span className="text-text-muted">{info.getValue() as string}</span> },
];

/** A `who-calls-by-name` candidate: a NAME match on a `property-get`, never
 *  a resolved edge (spec 17 §14.1) — deliberately in `text-text-muted`
 *  throughout (existing theme token, not a literal colour) so it reads as
 *  lighter-weight than an `XrefRow`'s proven `text-text` without inventing
 *  a new "heuristic" colour. */
function ByNameRow({ row }: { readonly row: ByNameCaller }): ReactNode {
  return (
    <button
      type="button"
      data-fn={row.fn}
      onClick={() => select({ kind: "fn", fn: row.fn })}
      className="flex w-full items-center gap-2 px-3 py-0.5 text-left font-mono text-xs text-text-muted hover:bg-surface-2"
      title={`heuristic candidate: reads property "${row.name}" (${row.role} x${row.n}) — confidence:by-name, not a proven caller`}
    >
      <span className="truncate">{row.callerName ?? `fn:${row.fn}`}</span>
      <span className="ml-auto shrink-0 text-text-muted">{row.file}:{row.line}</span>
    </button>
  );
}

/** Spec 26 L6: the status transitions a finding may move to next.
 *  `checkStatusTransition` (src/project/findings.ts) is the real gate — this
 *  is only the menu of what's worth OFFERING; a rejected pick still shows
 *  the backend's own message verbatim, never a client-side guess at why. */
const NEXT_STATUS: Readonly<Record<FindingStatus, readonly FindingStatus[]>> = {
  open: ["confirmed", "refuted"],
  confirmed: ["refuted"],
  refuted: ["open"],
};

/** Spec 26 L6: one finding row — evidence state (resolved/unresolved, with
 *  the ref), and, once the evidence resolves, the status-transition control.
 *  `set_finding_status`'s own truth rule 3 (`src/mcp/tools.ts`) still gates
 *  `open -> confirmed`, so a rejected transition here is expected, not a
 *  bug — its message is shown exactly as the server sent it. */
function FindingRow({ f }: { readonly f: ResolvedFinding }): ReactNode {
  const qc = useQueryClient();
  const next = NEXT_STATUS[f.status];
  const [to, setTo] = useState<FindingStatus>(next[0] ?? f.status);
  const [evidenceRef, setEvidenceRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const evidence = evidenceRef.trim() === "" ? [] : [{ ref: evidenceRef.trim(), role: "site" }];
      const res = await setFindingStatus(f.record.rid, to, evidence);
      await qc.invalidateQueries({ queryKey: ["findings"] });
      setEvidenceRef("");
      setError(null);
      void res;
    } catch (err) {
      setError(err instanceof ToolError ? err.reason : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="border-b border-border px-3 py-2 text-xs"
      title={f.valid ? "evidence resolves" : "candidate — evidence does not resolve yet"}
    >
      <div className="flex items-center gap-2">
        <span className={SEVERITY_CLASS[f.record.severity]}>{f.record.severity}</span>
        <span className="text-text-muted">{f.status}</span>
        {!f.valid && <span className="text-text-muted">candidate</span>}
        <span className="ml-auto font-mono text-text-muted">{f.record.target}</span>
      </div>
      <div className="pt-1 text-text">{f.record.claim}</div>
      {/* Spec 26 L6: evidence state per finding, resolved/unresolved, with
          the ref — `text-text` for a resolved ref, `text-text-muted` (the
          same "candidate/heuristic" weight as everywhere else in this
          pane) for one that does not. */}
      <div className="flex flex-wrap gap-2 pt-1 font-mono">
        {f.refs.map((r, i) => (
          <span key={`${r.ref.ref}-${i}`} className={r.resolved ? "text-text" : "text-text-muted"} title={r.resolved ? "resolves" : "does not resolve"}>
            {r.ref.ref}
          </span>
        ))}
      </div>
      {next.length > 0 && (
        <div className="flex items-center gap-1 pt-2">
          <select
            className="rounded-ui border border-border bg-surface-2 px-1 py-0.5 text-xs text-text"
            value={to}
            onChange={(e) => setTo(e.target.value as FindingStatus)}
            aria-label={`set status for ${f.record.rid}`}
          >
            {next.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input
            className="flex-1 rounded-ui border border-border bg-surface-2 px-1 py-0.5 font-mono text-xs text-text"
            placeholder="evidence ref (fn:/reg:/sid:/mod:, needed to confirm)"
            value={evidenceRef}
            onChange={(e) => setEvidenceRef(e.target.value)}
            spellCheck={false}
          />
          <ToolButton onClick={() => void apply()} disabled={busy} active>
            {busy ? "applying..." : "Apply"}
          </ToolButton>
        </div>
      )}
      {/* The backend's own rejection text, verbatim (spec 19 §1.4) —
          e.g. `set_finding_status`'s evidence-gate message on a refused
          `open -> confirmed`. */}
      {error !== null && <div className="pt-1 text-sev-crit">{error}</div>}
    </div>
  );
}

function KeyVal({ k, v }: { readonly k: string; readonly v: string | number | null | undefined }): ReactNode {
  return (
    <div className="flex gap-2 px-3 py-0.5 text-xs">
      <span className="w-28 shrink-0 text-text-muted">{k}</span>
      <span className="truncate font-mono text-text">{v ?? "—"}</span>
    </div>
  );
}

export function RightPane({ fn }: { readonly fn: number }): ReactNode {
  // Which panel is up is action-owned state: `navigate.xrefs` switches to
  // Xrefs from the menu, the palette or a chord (ui/src/actions/store.ts).
  const panel = useActionsState().rightPanel;
  const selection = useSelection();
  // `fn` is `-1` before anything is selected (App.tsx) — the same sentinel
  // `perFn()` already uses in hooks.ts to skip a query, so passing it straight
  // through disables `ctx`/`callers`/`callees`/`pkg` rather than fetching
  // `/api/fn/0/...` (fn 0 is the bytecode global function, has no recorded
  // source range and 400s — that was the first-paint console error).
  const hasFn = fn >= 0;
  const ctx = useContextResource(fn);
  const findingChord = keymap.chordFor("annotate.finding");
  const callers = useWhoCalls(fn);
  const callees = useCallsFrom(fn);
  // spec 17 §14.1: only pay for the by-name scan while the Xrefs tab is the
  // one actually visible for this fn — the same "lazily, gated on tab
  // visibility" rule StringsPane's mode=exact expansion already follows.
  const byName = useWhoCallsByName(fn, hasFn && panel === "xrefs");
  const findings = useFindings();
  const pkg = usePackageId(hasFn ? (ctx.data?.metadata?.module ?? 0) : -1);
  const md = ctx.data?.metadata;
  // segregation.ts attributes a module to `node_modules/<pkg>/…` from path
  // shape alone (no two-key gate) — a WEAKER claim than `packageId`'s, so
  // it is shown only as a fallback labelled as such, never in place of a
  // gated identification.
  const segregation = useSegregation();
  const segregationPackage = segregation.data?.modules.find((m) => m.id === md?.module)?.package ?? null;
  return (
    <Tabs.Root
      value={panel}
      onValueChange={(v) => setRightPanel(v as RightPanel)}
      className="flex h-full min-w-0 flex-col bg-surface"
    >
      <PaneHeader>
        <Tabs.List className="flex w-full gap-1">
          <Tabs.Trigger value="context" className={tabClass}>Context</Tabs.Trigger>
          <Tabs.Trigger value="xrefs" className={tabClass}>Xrefs</Tabs.Trigger>
          <Tabs.Trigger value="strings" className={tabClass}>Strings</Tabs.Trigger>
          <Tabs.Trigger value="tables" className={tabClass}>Tables</Tabs.Trigger>
          <Tabs.Trigger value="graph" className={tabClass}>Graph</Tabs.Trigger>
          <Tabs.Trigger value="findings" className={tabClass}>Findings</Tabs.Trigger>
          <Tabs.Trigger value="package" className={tabClass}>Package</Tabs.Trigger>
          <Tabs.Trigger value="workers" className={tabClass}>AI</Tabs.Trigger>
          <Tabs.Trigger value="edit" className={tabClass}>Edit</Tabs.Trigger>
        </Tabs.List>
      </PaneHeader>

      <Tabs.Content value="context" className={bodyClass}>
        {!hasFn ? (
          <Empty>select a function</Empty>
        ) : (
          <>
            <div className="py-2">
              <KeyVal k="name" v={displayName(md)} />
              <KeyVal k="fn" v={md?.fn} />
              <KeyVal k="module" v={md?.module} />
              <KeyVal k="file" v={md?.file} />
              <KeyVal k="lines" v={md?.lines === null || md?.lines === undefined ? null : `${md.lines[0]}-${md.lines[1]}`} />
              <KeyVal k="params" v={md?.params} />
              <KeyVal k="kind" v={md?.kind} />
              <KeyVal k="edges in/out" v={md === undefined ? null : `${md.edgesIn} / ${md.edgesOut}`} />
            </div>
            <div className="border-t border-border py-2">
              <div className="px-3 pb-1 text-xs text-text-muted">strings</div>
              {(ctx.data?.strings?.rows ?? []).map((s) => (
                <div key={s.sid} className="px-3 py-0.5 font-mono text-xs text-text">
                  sid:{s.sid} <span className="text-text-muted">{s.role} x{s.n}</span> {s.head}
                </div>
              ))}
            </div>
          </>
        )}
      </Tabs.Content>

      <Tabs.Content value="xrefs" className={bodyClass}>
        {!hasFn ? (
          <Empty>select a function</Empty>
        ) : (
          <>
            <div className="px-3 pt-2 pb-1 text-xs text-text-muted">
              called by ({callers.data?.total ?? 0})
              {callers.data !== undefined && callers.data.unknownInScope > 0 && <> · {callers.data.unknownInScope} unknown in scope</>}
            </div>
            <div className="h-40 min-h-0 shrink-0">
              <ResultTable
                data={callers.data?.rows ?? []}
                getRowId={(e) => `in-${e.fn}`}
                rowElement="button"
                rowProps={(e) => (typeof e.fn === "number" ? { "data-fn": e.fn } : {})}
                onRowClick={(e) => {
                  if (typeof e.fn === "number") select({ kind: "fn", fn: e.fn });
                }}
                emptyMessage="no callers recorded"
                columns={XREF_COLUMNS}
              />
            </div>
            <div className="px-3 pt-3 pb-1 text-xs text-text-muted">calls ({callees.data?.total ?? 0})</div>
            <div className="h-40 min-h-0 shrink-0">
              <ResultTable
                data={callees.data?.rows ?? []}
                getRowId={(e) => `out-${e.fn}`}
                rowElement="button"
                rowProps={(e) => (typeof e.fn === "number" ? { "data-fn": e.fn } : {})}
                onRowClick={(e) => {
                  if (typeof e.fn === "number") select({ kind: "fn", fn: e.fn });
                }}
                emptyMessage="no callees recorded"
                columns={XREF_COLUMNS}
              />
            </div>
            {/* spec 17 §14.1: heuristic name-based caller CANDIDATES, below
                the exact callers — hidden when the exact callers already
                answered (non-empty) and the heuristic scan found nothing,
                so a well-resolved fn does not grow a pointless extra
                section. */}
            {!(((callers.data?.total ?? 0) > 0) && byName.data !== undefined && byName.data.rows.length === 0) && (
              <div className="border-t border-border">
                <div className="px-3 pt-3 pb-1 text-xs text-text-muted">
                  Callers by name (heuristic){byName.data !== undefined && <> ({byName.data.total})</>}
                </div>
                {byName.data === undefined ? (
                  <div className="px-3 pb-2 text-xs text-text-muted">loading…</div>
                ) : byName.data.rows.length === 0 ? (
                  <div className="px-3 pb-2 text-xs text-text-muted">
                    {(() => {
                      const ambiguous = byName.data.names.find((n) => n.ambiguous);
                      return ambiguous !== undefined
                        ? `no by-name candidates: "${ambiguous.name}" is too common a property name to use as a dispatch signal${ambiguous.why !== undefined ? ` — ${ambiguous.why}` : ""}.`
                        : "no by-name candidates.";
                    })()}
                  </div>
                ) : (
                  <>
                    <div className="px-3 pb-1 text-xs text-text-muted">
                      candidates only — a name match on a property read, not a proven call
                    </div>
                    {byName.data.rows.map((r) => <ByNameRow key={`byname-${r.fn}-${r.name}-${r.role}`} row={r} />)}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </Tabs.Content>

      {/* spec 22 §3: strings/globals xref window — not gated on `hasFn`,
          unlike Xrefs/Package, since a string/global search is not about
          the currently-selected function. */}
      <Tabs.Content value="strings" className={bodyClass}>
        <StringsPane />
      </Tabs.Content>

      {/* spec 17 §14.2: bundle-wide constant object-literal inventory —
          not gated on `hasFn` either, same reasoning as Strings. */}
      <Tabs.Content value="tables" className={bodyClass}>
        <TablesPane />
      </Tabs.Content>

      {/* Spec 25: the neighbourhood graph. `flex` (not the scrolling
          `bodyClass`) — React Flow owns its own pan/zoom viewport and must
          fill the panel rather than scroll inside it. */}
      <Tabs.Content value="graph" className="flex min-h-0 flex-1 flex-col outline-none">
        <GraphPane visible={panel === "graph"} />
      </Tabs.Content>

      <Tabs.Content value="findings" className={bodyClass}>
        {/* Spec 22 §3.6: the same `annotate.finding` action the context menu
            and the palette expose, with a visible button on the panel. */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-xs text-text-muted">{findings.data?.total ?? 0} finding(s)</span>
          <ToolButton
            className="ml-auto"
            active={hasFn || selection.fn !== undefined}
            {...(findingChord !== undefined ? { tip: findingChord } : {})}
            onClick={() => {
              if (!hasFn && selection.fn === undefined) return;
              openDialog("finding", selection.fn === undefined ? { kind: "fn", fn } : selection);
            }}
          >
            Add finding
          </ToolButton>
        </div>
        {(findings.data?.rows ?? []).length === 0 && <Empty>No findings recorded.</Empty>}
        {(findings.data?.rows ?? []).map((f) => <FindingRow key={f.record.rid} f={f} />)}
      </Tabs.Content>

      <Tabs.Content value="package" className={bodyClass}>
        {!hasFn ? (
          <Empty>select a function</Empty>
        ) : pkg.data === undefined ? (
          <Empty>loading...</Empty>
        ) : pkg.data.available ? (
          <div className="py-2">
            <KeyVal k="package" v={pkg.data.package} />
            <KeyVal k="version" v={pkg.data.version} />
            <KeyVal k="tier" v={pkg.data.tier} />
            <KeyVal k="identity basis" v={pkg.data.identityBasis} />
            <KeyVal k="version basis" v={pkg.data.versionBasis} />
            <KeyVal k="evidence" v={pkg.data.evidence} />
          </div>
        ) : (
          <div className="py-2">
            <Empty>not identified — {pkg.data.reason}</Empty>
            {segregationPackage !== null && (
              <div className="px-3 pt-1">
                <KeyVal k="package (unverified)" v={segregationPackage} />
                <div className="pt-1 text-xs text-text-muted">
                  attributed by segregation, not gated — path shape only, no spec-13 two-key check
                </div>
              </div>
            )}
          </div>
        )}
      </Tabs.Content>

      {/* spec 23 §6: jobs rail + presence + accept/reject, owned by
          ui/src/panes/WorkersPane.tsx. */}
      <Tabs.Content value="workers" className={bodyClass}>
        <WorkersPane fn={fn} />
      </Tabs.Content>

      <Tabs.Content value="edit" className={bodyClass}>
        <EditPane fn={fn} />
      </Tabs.Content>
    </Tabs.Root>
  );
}
