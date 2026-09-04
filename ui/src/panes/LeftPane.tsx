// ui/src/panes/LeftPane.tsx — the module tree and the leads list (spec 22
// §3.2). Real data: `GET /api/modules` for the module set, grouped SCREENS
// FIRST by `GET /api/segregation`'s recovered paths (Screens, Navigation,
// App, one group per node_modules package, Unclassified last —
// `groupModulesSegregated` in ui/src/listing/modules.ts), each module
// expanding into its functions from its own file view. A production Metro
// bundle has no module paths at all, so grouping by `ModuleEntry.file` puts
// every module in one group; when segregation is unavailable the grouping
// falls back to exactly that, never to a blank tree.
//
// Navigation is a roving-focus list, not per-row tab stops: the container
// owns focus, Up/Down move a cursor over the *visible* rows, Enter opens,
// Left/Right collapse and expand. Every function row carries `data-fn`, so
// the keymap track can drive this list from outside without a React handle.
import * as Tabs from "@radix-ui/react-tabs";
import * as ContextMenu from "@radix-ui/react-context-menu";
import clsx from "clsx";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Empty, PaneHeader } from "../components/primitives.tsx";
import { useLeads, useModuleSources, useModules, useSearchFunctions } from "../hooks.ts";
import { defaultOpenGroups, filterGroups, fnLabel, groupModulesSegregated, moduleLabelSegregated, segregationById } from "../listing/modules.ts";
import { useSegregation } from "../listing/use-segregation.ts";
import { useQueryText } from "../listing/search-store.ts";
import { select, useSelection } from "../state/selection.ts";
import type { ModuleEntry } from "../listing/wire.ts";
import type { ModuleSourceFn } from "../contracts.ts";

const MENU_ITEMS: readonly string[] = ["Rename", "Add comment", "Go to definition", "Find xrefs", "Mark reviewed", "Copy disasm offset"];

function RowMenu({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-44 rounded-ui border border-border bg-surface p-1 text-xs text-text">
          {MENU_ITEMS.map((label) => (
            <ContextMenu.Item
              key={label}
              disabled
              className="flex h-7 items-center rounded-ui px-2 outline-none data-[disabled]:text-text-muted data-[highlighted]:bg-surface-2"
            >
              {label}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

const tabClass =
  "h-7 flex-1 rounded-ui px-2 text-xs text-text-muted outline-none data-[state=active]:bg-surface-2 data-[state=active]:text-text";

/** One row of the flattened tree — what the keyboard cursor walks. */
type TreeRow =
  | { readonly kind: "group"; readonly key: string; readonly label: string; readonly count: number; readonly open: boolean }
  | { readonly kind: "module"; readonly key: string; readonly module: ModuleEntry; readonly count: number; readonly open: boolean; readonly depth: number }
  | { readonly kind: "fn"; readonly key: string; readonly row: ModuleSourceFn; readonly depth: number };

function useOpenSet(initial: readonly string[]): [ReadonlySet<string>, (key: string, force?: boolean) => void] {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(initial));
  const toggle = (key: string, force?: boolean): void => {
    setOpen((prev) => {
      const next = new Set(prev);
      const want = force ?? !next.has(key);
      if (want) next.add(key);
      else next.delete(key);
      return next;
    });
  };
  return [open, toggle];
}

export function LeftPane(): ReactNode {
  const modules = useModules();
  const leads = useLeads();
  const sel = useSelection();
  const query = useQueryText();
  const hits = useSearchFunctions(query);

  const seg = useSegregation();
  const [openGroups, toggleGroup] = useOpenSet(["app"]);
  const [openModules, toggleModule] = useOpenSet([]);
  const [cursor, setCursor] = useState(0);

  const segById = useMemo(() => segregationById(seg.data ?? null), [seg.data]);
  const groups = useMemo(
    () => groupModulesSegregated(modules.data?.rows ?? [], seg.data ?? null),
    [modules.data, seg.data],
  );
  const labelOf = useMemo(() => (m: ModuleEntry): string => moduleLabelSegregated(m, segById.get(m.id)), [segById]);

  // Screens and Navigation open themselves once, when segregation arrives —
  // not on every render, so a group the analyst closed by hand stays closed.
  const openedDefaults = useRef(false);
  useEffect(() => {
    if (openedDefaults.current) return;
    const keys = defaultOpenGroups(groups);
    if (keys.length === 0) return;
    openedDefaults.current = true;
    for (const k of keys) toggleGroup(k, true);
    // `toggleGroup` is a stable setState wrapper; `groups` is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  // Functions come from the FILE VIEW of the modules that are open, not from
  // a walk of `/api/functions?cursor=`: a real bundle has 15 000 functions
  // (300 pages) and the tree only ever shows the handful in open modules.
  const openIds = useMemo(
    () => [...openModules].map((k) => Number(k.slice(2))).filter((n) => Number.isInteger(n)),
    [openModules],
  );
  const sources = useModuleSources(openIds);
  const searching = query.trim() !== "";

  const rows = useMemo<readonly TreeRow[]>(() => {
    const out: TreeRow[] = [];
    for (const g of groups) {
      const groupOpen = openGroups.has(g.key);
      out.push({ kind: "group", key: g.key, label: g.label, count: g.modules.length, open: groupOpen });
      if (!groupOpen) continue;
      for (const m of g.modules) {
        const key = `m:${m.id}`;
        const moduleOpen = openModules.has(key);
        const fns = sources.get(m.id)?.functions ?? [];
        out.push({ kind: "module", key, module: m, count: fns.length, open: moduleOpen, depth: 1 });
        if (!moduleOpen) continue;
        for (const r of fns) out.push({ kind: "fn", key: `f:${r.fn}`, row: r, depth: 2 });
      }
    }
    return out;
  }, [groups, openGroups, openModules, sources]);

  // Nothing is selected on load, and fn 0 (the global function) has no
  // recorded source range — opening it returns 400, not a listing. Land on
  // the first module's FILE instead: the file view is the listing.
  useEffect(() => {
    if (sel.kind !== "none") return;
    const first = groups[0];
    const m = first?.modules[0];
    if (first === undefined || m === undefined) return;
    toggleGroup(first.key, true);
    toggleModule(`m:${m.id}`, true);
    select({ kind: "module", moduleId: String(m.id) });
    // `toggle*` are stable setState wrappers; `groups` is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, sel.kind]);

  const activate = (row: TreeRow): void => {
    if (row.kind === "group") toggleGroup(row.key);
    else if (row.kind === "module") {
      toggleModule(row.key);
      select({ kind: "module", moduleId: String(row.module.id) });
    } else select({ kind: "fn", fn: row.row.fn, name: fnLabel(row.row) });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (rows.length === 0) return;
    const at = Math.min(cursor, rows.length - 1);
    const row = rows[at]!;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(Math.min(at + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(Math.max(at - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate(row);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (row.kind === "group") toggleGroup(row.key, true);
      else if (row.kind === "module") toggleModule(row.key, true);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (row.kind === "group") toggleGroup(row.key, false);
      else if (row.kind === "module") toggleModule(row.key, false);
    }
  };

  const rowClass = (selected: boolean, active: boolean): string =>
    clsx(
      "flex w-full items-center gap-2 px-2 text-left text-xs h-[var(--row-height)] border-l-2 cursor-default",
      selected ? "border-l-accent bg-surface-2 text-text" : "border-l-transparent text-text-muted hover:bg-surface-2 hover:text-text",
      active && "ring-1 ring-inset ring-accent",
    );

  /** With a query in the top bar the tree steps aside for a flat hit list:
   *  `search/functions` returns fn ids without module ids, and at 15 000
   *  functions resolving each one's module to graft it into the tree would
   *  be 15 000 requests. */
  const searchBody = ((): ReactNode => {
    const moduleHits = filterGroups(groups, query, labelOf).flatMap((g) => g.modules.map((m) => ({ group: g.label, module: m }))).slice(0, 100);
    if (hits.isLoading && moduleHits.length === 0) return <Empty>searching…</Empty>;
    const rowsOut = (hits.data?.rows ?? []).slice(0, 200);
    if (rowsOut.length === 0 && moduleHits.length === 0) return <Empty>nothing matches “{query}”</Empty>;
    return (
      <>
        {moduleHits.length > 0 && <div className="px-2 py-1 text-xs uppercase text-text-muted">modules</div>}
        {moduleHits.map(({ group, module: m }) => (
          <div
            key={`sm:${m.id}`}
            data-module={m.id}
            title={group}
            className={rowClass(sel.kind === "module" && sel.moduleId === String(m.id), false)}
            onClick={() => select({ kind: "module", moduleId: String(m.id) })}
          >
            <span className="truncate">{labelOf(m)}</span>
            <span className="ml-auto shrink-0 truncate font-mono text-text-muted">module_{m.id}</span>
          </div>
        ))}
        {moduleHits.length > 0 && rowsOut.length > 0 && <div className="px-2 py-1 text-xs uppercase text-text-muted">functions</div>}
        {rowsOut.map((r) => (
          <RowMenu key={r.fn}>
            <div
              data-fn={r.fn}
              className={rowClass(sel.fn === r.fn, false)}
              onClick={() => select({ kind: "fn", fn: r.fn, ...(r.name !== null ? { name: r.name } : {}) })}
            >
              <span className="truncate font-mono">{r.name ?? `fn ${r.fn}`}</span>
              <span className="ml-auto shrink-0 tabular-nums text-text-muted">{r.size ?? ""}</span>
            </div>
          </RowMenu>
        ))}
        {(hits.data?.total ?? 0) > rowsOut.length && (
          <div className="px-2 py-1 text-xs text-text-muted">{(hits.data?.total ?? 0) - rowsOut.length} more not shown</div>
        )}
      </>
    );
  })();

  const body = ((): ReactNode => {
    if (searching) return searchBody;
    if (modules.isLoading) return <Empty>loading modules…</Empty>;
    // Segregation is seconds of work on a 4,510-module bundle (the server
    // warms it at startup, but a browser can still beat it there). Say so
    // rather than painting the flat one-group fallback tree and then
    // reshuffling it under the analyst's cursor — the fallback is for a
    // server that CANNOT segregate (404/error -> `data === null`), not for
    // one that has not answered yet.
    if (seg.isLoading) return <Empty>recovering module names…</Empty>;
    if (modules.isError) return <Empty>could not load /api/modules</Empty>;
    if (rows.length === 0) return <Empty>no modules in this artifact</Empty>;
    return rows.map((row, i) => {
      const active = i === Math.min(cursor, rows.length - 1);
      if (row.kind === "group") {
        return (
          <div
            key={row.key}
            data-group={row.key}
            className={rowClass(false, active)}
            onClick={() => { setCursor(i); activate(row); }}
          >
            <span className="font-mono text-text-muted">{row.open ? "v" : ">"}</span>
            <span className="truncate text-text">{row.label}</span>
            <span className="ml-auto shrink-0 tabular-nums text-text-muted">{row.count}</span>
          </div>
        );
      }
      if (row.kind === "module") {
        const selected = sel.kind === "module" && sel.moduleId === String(row.module.id);
        return (
          <RowMenu key={row.key}>
            <div
              data-module={row.module.id}
              className={rowClass(selected, active)}
              style={{ paddingLeft: `calc(0.5rem + ${row.depth} * 0.75rem)` }}
              onClick={() => { setCursor(i); activate(row); }}
              title={segById.get(row.module.id)?.path ?? row.module.file}
            >
              <span className="font-mono text-text-muted">{row.open ? "v" : ">"}</span>
              <span className="truncate">{labelOf(row.module)}</span>
              <span className="shrink-0 font-mono text-[0.9em] text-text-muted opacity-60">module_{row.module.id}</span>
              <span className="ml-auto shrink-0 tabular-nums text-text-muted">{row.count}</span>
            </div>
          </RowMenu>
        );
      }
      const selected = sel.fn === row.row.fn && sel.kind !== "module";
      return (
        <RowMenu key={row.key}>
          <div
            data-fn={row.row.fn}
            className={rowClass(selected, active)}
            style={{ paddingLeft: `calc(0.5rem + ${row.depth} * 0.75rem)` }}
            onClick={() => { setCursor(i); activate(row); }}
          >
            <span className="truncate font-mono">{fnLabel(row.row)}</span>
            <span className="ml-auto shrink-0 tabular-nums text-text-muted">{row.row.lines[0]}</span>
          </div>
        </RowMenu>
      );
    });
  })();

  return (
    <Tabs.Root defaultValue="modules" className="flex h-full min-w-0 flex-col bg-surface">
      <PaneHeader>
        <Tabs.List className="flex w-full gap-1">
          <Tabs.Trigger value="modules" className={tabClass}>Modules</Tabs.Trigger>
          <Tabs.Trigger value="leads" className={tabClass}>Leads</Tabs.Trigger>
        </Tabs.List>
      </PaneHeader>
      <Tabs.Content value="modules" className="min-h-0 flex-1 outline-none">
        <div
          role="tree"
          aria-label="module tree"
          tabIndex={0}
          onKeyDown={onKeyDown}
          data-tree="modules"
          className="hbc-scroll h-full overflow-auto py-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
        >
          {body}
        </div>
        {modules.data?.truncated === true && (
          <div className="border-t border-border px-2 py-1 text-xs text-text-muted">
            module list truncated — showing the first {modules.data?.rows.length ?? 0} of {modules.data?.total ?? 0}
          </div>
        )}
      </Tabs.Content>
      <Tabs.Content value="leads" className="hbc-scroll min-h-0 flex-1 overflow-auto py-1 outline-none">
        {(leads.data?.groups ?? []).map((g) => (
          <div key={g.class}>
            <div className="px-2 py-1 text-xs uppercase text-text-muted">{g.class}</div>
            {g.leads.map((l) => (
              <RowMenu key={l.evidence}>
                <div
                  {...(l.fn !== null ? { "data-fn": l.fn } : {})}
                  className={rowClass(l.fn !== null && l.fn === sel.fn, false)}
                  onClick={() => { if (l.fn !== null) select({ kind: "fn", fn: l.fn, ...(l.name !== null ? { name: l.name } : {}) }); }}
                >
                  <span className="truncate font-mono">{l.name ?? l.evidence}</span>
                  <span className="ml-auto shrink-0 truncate text-text-muted">{l.detail}</span>
                </div>
              </RowMenu>
            ))}
          </div>
        ))}
        {leads.data === undefined && <Empty>loading leads…</Empty>}
      </Tabs.Content>
    </Tabs.Root>
  );
}
