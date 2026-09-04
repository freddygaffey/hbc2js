// ui/src/panes/RightPane.tsx — ONE panel visible at a time (spec 22 §2):
// Context / Xrefs / Findings / Package.
import * as Tabs from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { Empty, PaneHeader, ToolButton } from "../components/primitives.tsx";
import { useCallsFrom, useContextResource, useFindings, usePackageId, useWhoCalls } from "../hooks.ts";
import { useSegregation } from "../listing/use-segregation.ts";
import type { Severity, XrefEdge } from "../contracts.ts";
import { displayName } from "../actions/names.ts";
import { openDialog, setRightPanel, useActionsState, type RightPanel } from "../actions/store.ts";
import { keymap } from "../actions/registry.ts";
import { select, useSelection } from "../state/selection.ts";
import { WorkersPane } from "./WorkersPane.tsx";

const tabClass =
  "h-7 flex-1 rounded-ui px-2 text-xs text-text-muted outline-none data-[state=active]:bg-surface-2 data-[state=active]:text-text";
const bodyClass = "hbc-scroll min-h-0 flex-1 overflow-auto outline-none";

const SEVERITY_CLASS: Readonly<Record<Severity, string>> = {
  critical: "text-sev-crit",
  high: "text-sev-high",
  med: "text-sev-med",
  low: "text-sev-ok",
};

/** One xref row: clicking it selects that function, which is what makes the
 *  Xrefs panel a navigation surface rather than a list of numbers. */
function XrefRow({ edge, dir }: { readonly edge: XrefEdge; readonly dir: "in" | "out" }): ReactNode {
  // `NeighborRef.fn` is `number | string` (a native/unknown neighbour has no
  // fn index); only a numeric one is navigable.
  const target = typeof edge.fn === "number" ? edge.fn : Number.NaN;
  return (
    <button
      type="button"
      disabled={Number.isNaN(target)}
      onClick={() => select({ kind: "fn", fn: target })}
      className="flex w-full items-center gap-2 px-3 py-0.5 text-left font-mono text-xs text-text hover:bg-surface-2"
      title={`${dir === "in" ? "called by" : "calls"} fn:${edge.fn}`}
    >
      <span className="truncate">{edge.name ?? edge.fn}</span>
      <span className="ml-auto shrink-0 text-text-muted">{edge.file}:{edge.line}</span>
    </button>
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
          <Tabs.Trigger value="findings" className={tabClass}>Findings</Tabs.Trigger>
          <Tabs.Trigger value="package" className={tabClass}>Package</Tabs.Trigger>
          <Tabs.Trigger value="workers" className={tabClass}>AI</Tabs.Trigger>
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
            {(callers.data?.rows ?? []).map((e) => <XrefRow key={`in-${e.fn}`} edge={e} dir="in" />)}
            <div className="px-3 pt-3 pb-1 text-xs text-text-muted">calls ({callees.data?.total ?? 0})</div>
            {(callees.data?.rows ?? []).map((e) => <XrefRow key={`out-${e.fn}`} edge={e} dir="out" />)}
          </>
        )}
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
        {(findings.data?.rows ?? []).map((f) => (
          <div
            key={f.record.rid}
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
          </div>
        ))}
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
    </Tabs.Root>
  );
}
