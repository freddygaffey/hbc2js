// ui/src/panes/RightPane.tsx — ONE panel visible at a time (spec 22 §2):
// Context / Xrefs / Findings / Package.
import * as Tabs from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { Empty, PaneHeader, Stub } from "../components/primitives.tsx";
import { useCallsFrom, useContextResource, useFindings, usePackageId, useWhoCalls } from "../hooks.ts";
import type { Severity } from "../contracts.ts";

const tabClass =
  "h-7 flex-1 rounded-ui px-2 text-xs text-text-muted outline-none data-[state=active]:bg-surface-2 data-[state=active]:text-text";
const bodyClass = "hbc-scroll min-h-0 flex-1 overflow-auto outline-none";

const SEVERITY_CLASS: Readonly<Record<Severity, string>> = {
  critical: "text-sev-crit",
  high: "text-sev-high",
  med: "text-sev-med",
  low: "text-sev-ok",
};

function KeyVal({ k, v }: { readonly k: string; readonly v: string | number | null | undefined }): ReactNode {
  return (
    <div className="flex gap-2 px-3 py-0.5 text-xs">
      <span className="w-28 shrink-0 text-text-muted">{k}</span>
      <span className="truncate font-mono text-text">{v ?? "—"}</span>
    </div>
  );
}

export function RightPane({ fn }: { readonly fn: number }): ReactNode {
  const ctx = useContextResource(fn);
  const callers = useWhoCalls(fn);
  const callees = useCallsFrom(fn);
  const findings = useFindings();
  const pkg = usePackageId(ctx.data?.metadata?.module ?? 0);
  const md = ctx.data?.metadata;
  return (
    <Tabs.Root defaultValue="context" className="flex h-full min-w-0 flex-col bg-surface">
      <PaneHeader>
        <Tabs.List className="flex w-full gap-1">
          <Tabs.Trigger value="context" className={tabClass}>Context</Tabs.Trigger>
          <Tabs.Trigger value="xrefs" className={tabClass}>Xrefs</Tabs.Trigger>
          <Tabs.Trigger value="findings" className={tabClass}>Findings</Tabs.Trigger>
          <Tabs.Trigger value="package" className={tabClass}>Package</Tabs.Trigger>
        </Tabs.List>
      </PaneHeader>

      <Tabs.Content value="context" className={bodyClass}>
        <div className="py-2">
          <KeyVal k="name" v={md?.overlayName ?? md?.name} />
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
      </Tabs.Content>

      <Tabs.Content value="xrefs" className={bodyClass}>
        <div className="px-3 pt-2 pb-1 text-xs text-text-muted">
          called by ({callers.data?.total ?? 0})
          {callers.data !== undefined && callers.data.unknownInScope > 0 && <> · {callers.data.unknownInScope} unknown in scope</>}
        </div>
        {(callers.data?.rows ?? []).map((e) => (
          <div key={`in-${e.fn}`} className="px-3 py-0.5 font-mono text-xs text-text">
            {e.name ?? e.fn} <span className="text-text-muted">{e.file}:{e.line}</span>
          </div>
        ))}
        <div className="px-3 pt-3 pb-1 text-xs text-text-muted">calls ({callees.data?.total ?? 0})</div>
        {(callees.data?.rows ?? []).map((e) => (
          <div key={`out-${e.fn}`} className="px-3 py-0.5 font-mono text-xs text-text">
            {e.name ?? e.fn} <span className="text-text-muted">{e.file}:{e.line}</span>
          </div>
        ))}
      </Tabs.Content>

      <Tabs.Content value="findings" className={bodyClass}>
        {(findings.data?.rows ?? []).length === 0 && <Empty>No findings recorded.</Empty>}
        {(findings.data?.rows ?? []).map((f) => (
          <div key={f.record.rid} className="border-b border-border px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <span className={SEVERITY_CLASS[f.record.severity]}>{f.record.severity}</span>
              <span className="text-text-muted">{f.status}</span>
              <span className="ml-auto font-mono text-text-muted">{f.record.target}</span>
            </div>
            <div className="pt-1 text-text">{f.record.claim}</div>
          </div>
        ))}
      </Tabs.Content>

      <Tabs.Content value="package" className={bodyClass}>
        {pkg.data === undefined ? (
          <Empty>loading...</Empty>
        ) : pkg.data.available ? (
          <div className="py-2">
            <KeyVal k="package" v={pkg.data.package} />
            <KeyVal k="version" v={pkg.data.version} />
            <KeyVal k="tier" v={pkg.data.tier} />
            <KeyVal k="evidence" v={pkg.data.evidence} />
          </div>
        ) : (
          <Empty>not identified — {pkg.data.reason}</Empty>
        )}
        <Stub what="package identification is served by McpResources.packageId once src/ui-server lands" />
      </Tabs.Content>
    </Tabs.Root>
  );
}
