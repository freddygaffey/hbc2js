// ui/src/components/KitchenSink.tsx — spec 20 §1.7 step 2 / spec 26 L7's
// `?kitchen-sink` route: every primitive rendered once, so a screenshot
// covers components in isolation before any real view exists. Reached via
// `index.html?kitchen-sink` (ui/src/main.tsx swaps it in for <App/>) — a
// query flag, not a router dependency, since this is the only route the
// shell has.
//
// The ONLY remaining consumer of ui/src/mock.ts once the real server is
// always present elsewhere (spec 26 L7 scope note): it calls `mockApi`
// directly, never `./api.ts`, so this route renders real-shaped fake data
// with no live project and no dependency on VITE_API_MOCK.
import * as Tooltip from "@radix-ui/react-tooltip";
import { useEffect, useState, type ReactNode } from "react";
import { mockApi } from "../mock.ts";
import type { FnSummary } from "../contracts.ts";
import { Empty, PaneHeader, Row, Stub, ToolButton } from "./primitives.tsx";

// Static class strings (never interpolated — Tailwind's build-time scanner
// needs a literal to see, the same discipline ui/src/panes/RightPane.tsx's
// `SEV_CLASS`-style lookup already uses).
const SEVERITY_CLASS: Readonly<Record<"crit" | "high" | "med" | "ok", string>> = {
  crit: "text-sev-crit", high: "text-sev-high", med: "text-sev-med", ok: "text-sev-ok",
};
const SEVERITIES = ["crit", "high", "med", "ok"] as const;

const TYPE_CLASS: Readonly<Record<"xs" | "sm" | "base" | "lg", string>> = {
  xs: "text-xs", sm: "text-sm", base: "text-base", lg: "text-lg",
};
const TYPE_STEPS = ["xs", "sm", "base", "lg"] as const;

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactNode {
  return (
    <section className="border-b border-border p-3">
      <h2 className="mb-2 text-sm font-semibold text-text">{title}</h2>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </section>
  );
}

export function KitchenSink(): ReactNode {
  const [sample, setSample] = useState<FnSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    mockApi.fn(0).then((s) => {
      if (!cancelled) setSample(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    // Mounted standalone by main.tsx (never inside App.tsx's own
    // Tooltip.Provider), so KitchenSink supplies its own — the ToolButton
    // primitive's `tip` prop needs a Tooltip.Provider ancestor.
    <Tooltip.Provider delayDuration={400}>
    <div data-testid="kitchen-sink" className="hbc-scroll h-screen overflow-auto bg-bg text-text">
      <header className="border-b border-border p-3">
        <h1 className="text-lg font-semibold text-text">Kitchen sink</h1>
        <p className="text-xs text-text-muted">
          Every primitive, once, on whichever theme slot is active — spec 20 §1.7 step 2.
        </p>
      </header>

      <Section title="Buttons (ToolButton)">
        <ToolButton>Default</ToolButton>
        <ToolButton active>Active</ToolButton>
        <ToolButton tip="A tooltip, Radix-driven">With tooltip</ToolButton>
        <ToolButton disabled>Disabled</ToolButton>
      </Section>

      <Section title="Pane header">
        <div className="w-64 border border-border">
          <PaneHeader>
            <span>a pane header</span>
          </PaneHeader>
        </div>
      </Section>

      <Section title="Rows (list primitive)">
        <div className="w-64 border border-border">
          <Row>unselected row</Row>
          <Row selected>selected row</Row>
        </div>
      </Section>

      <Section title="Empty / Stub states">
        <div className="w-64 border border-border">
          <Empty>nothing here yet</Empty>
        </div>
        <div className="w-64">
          <Stub what="a pane that has not landed" />
        </div>
      </Section>

      <Section title="Severity">
        {SEVERITIES.map((sev) => (
          <span
            key={sev}
            data-testid={`sev-${sev}`}
            className={`rounded-ui border border-border px-2 py-1 text-xs ${SEVERITY_CLASS[sev]}`}
          >
            {sev}
          </span>
        ))}
      </Section>

      <Section title="Type ramp">
        {TYPE_STEPS.map((step) => (
          <span key={step} data-testid={`type-${step}`} className={`${TYPE_CLASS[step]} text-text`}>
            text-{step}
          </span>
        ))}
      </Section>

      <Section title="Elevation">
        <div data-testid="elevation-0" className="rounded-ui border border-border bg-elevation-0 px-3 py-2 text-xs">
          level0
        </div>
        <div data-testid="elevation-1" className="rounded-ui border border-border bg-elevation-1 px-3 py-2 text-xs">
          level1
        </div>
      </Section>

      <Section title="Accent (the one interactive colour)">
        <div className="rounded-ui bg-accent px-3 py-2 text-xs text-accent-fg" data-testid="accent-swatch">
          accent / accent-fg
        </div>
      </Section>

      <Section title="Mono / syntax swatches (source pane palette)">
        <span className="font-mono text-xs text-syntax-comment">// comment</span>
        <span className="font-mono text-xs text-syntax-keyword">const</span>
        <span className="font-mono text-xs text-syntax-string">&quot;string&quot;</span>
        <span className="font-mono text-xs text-syntax-number">42</span>
        <span className="font-mono text-xs text-syntax-function">fn()</span>
        <span className="font-mono text-xs text-syntax-variable">x</span>
        <span className="font-mono text-xs text-syntax-operator">+</span>
        <span className="font-mono text-xs text-syntax-invalid">invalid</span>
      </Section>

      <Section title="Sample data (mockApi, spec 26 L7's route)">
        {sample === null ? (
          <Empty>loading a sample fn from the mock adapter…</Empty>
        ) : (
          <div data-testid="sample-fn" className="text-xs text-text">
            fn {sample.fn} — {sample.name ?? "(anonymous)"} — {sample.kind}
          </div>
        )}
      </Section>
    </div>
    </Tooltip.Provider>
  );
}
