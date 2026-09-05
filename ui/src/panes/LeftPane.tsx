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
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Empty, PaneHeader } from "../components/primitives.tsx";
import { ResultTable } from "../components/ResultTable.tsx";
import { useLeads, useModuleSources, useModules, useSearchFunctions } from "../hooks.ts";
import {
  defaultOpenGroups, filterGroups, flattenTree, fnLabel, groupModulesSegregated, indexOfFnRow, indexOfModuleRow,
  moduleLabelSegregated, segregationById, type TreeRow,
} from "../listing/modules.ts";
import { useSegregation } from "../listing/use-segregation.ts";
import { useScreens } from "../listing/use-screens.ts";
import { orderScreenGroups, screenDepths, screenEdges, screensByMod, screensTree } from "../listing/screens.ts";
import { useQueryText } from "../listing/search-store.ts";
import { select, useSelection } from "../state/selection.ts";
import type { ModuleEntry } from "../listing/wire.ts";

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

// `TreeRow` and the flatten/index-lookup helpers live in
// ../listing/modules.ts — pure and framework-free, so tests/gate/ui can
// exercise them without a browser (see flattenTree's own comment there).

/** Row height, read once from the `--row-height` token (`ui/themes/*.json`,
 *  set on `:root` before the first render — see `ui/src/theme/apply.ts`) so
 *  the virtualizer's initial estimate matches the real row instead of
 *  under/over-shooting the scrollbar before the first row is measured.
 *  `useVirtualizer`'s `measureElement` corrects it exactly after that, so
 *  this only has to be close, not exact — and a density toggle mid-session
 *  is caught by the next real measurement, not by re-reading the token. */
function readRowHeightPx(): number {
  if (typeof window === "undefined") return 32;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--row-height").trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 32;
}

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
  // The Leads tab's data is the single most expensive read the server has
  // (see `useLeads`), so the tab is what asks for it: `leadsWanted` latches
  // true the first time the analyst opens the tab and stays true, so
  // switching back to Modules does not throw the answer away.
  const [tab, setTab] = useState<string>("modules");
  const [leadsWanted, setLeadsWanted] = useState(false);
  const leads = useLeads(leadsWanted);
  const sel = useSelection();
  const query = useQueryText();
  const hits = useSearchFunctions(query);

  const seg = useSegregation();
  // Spec 26 L4: the hierarchy and the navigation arrows. A server without
  // `GET /api/screens` (or a project it 404s for) answers `null` and the
  // Screens group stays exactly the flat list it was.
  const screens = useScreens();
  const [openGroups, toggleGroup] = useOpenSet(["app"]);
  const [openModules, toggleModule] = useOpenSet([]);
  const [cursor, setCursor] = useState(0);

  // `seg.data?.computing === true` is the server's placeholder (its own
  // off-main-thread compute has not landed yet, `modules: []`) — treated
  // exactly like `null` here so the tree shows the flat fallback grouping
  // meanwhile instead of an (empty) segregated one; `useSegregation`'s poll
  // loop re-fetches until it settles.
  const segData = seg.data?.computing === true ? null : (seg.data ?? null);
  const segById = useMemo(() => segregationById(segData), [segData]);
  const groups = useMemo(
    () => groupModulesSegregated(modules.data?.rows ?? [], segData),
    [modules.data, segData],
  );
  const labelOf = useMemo(() => (m: ModuleEntry): string => moduleLabelSegregated(m, segById.get(m.id)), [segById]);

  // The screens forest, and the two projections the tree needs from it: how
  // deep each screen sits, and which arrows hang under it. Both are pure
  // (`ui/src/listing/screens.ts`) and both drop anything the answer cannot
  // also show as a row.
  const screenData = screens.data?.computing === true ? null : (screens.data ?? null);
  const screenNodes = useMemo(() => screensTree(screenData), [screenData]);
  const screenRowByMod = useMemo(() => screensByMod(screenData), [screenData]);
  const screenDepthOf = useMemo(() => screenDepths(screenNodes), [screenNodes]);
  const screenEdgeOf = useMemo(() => screenEdges(screenNodes), [screenNodes]);
  const screenLabelOf = (mod: number): string => screenRowByMod.get(mod)?.label ?? `module_${mod}`;

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

  const rows = useMemo<readonly TreeRow[]>(
    () => flattenTree(orderScreenGroups(groups, screenNodes), openGroups, openModules, (id) => sources.get(id)?.functions ?? [], {
      depthOf: (m) => screenDepthOf.get(m.id),
      rowsAfter: (m) =>
        (screenEdgeOf.get(m.id) ?? []).map((e) => ({
          kind: "nav" as const,
          key: `n:${m.id}>${e.mod}:${e.via}`,
          from: m.id,
          to: e.mod,
          label: screenLabelOf(e.mod),
          confidence: e.confidence,
          depth: (screenDepthOf.get(m.id) ?? 1) + 1,
        })),
    }),
    // `screenLabelOf` reads `screenRowByMod`, which is in the dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, openGroups, openModules, sources, screenNodes, screenDepthOf, screenEdgeOf, screenRowByMod],
  );

  // Virtualised: only the rows the viewport can show are ever mounted (spec
  // 22 §2's known debt — Service NSW's tree is ~4.5k modules / ~15k
  // functions once every group is open, which used to mean that many real
  // DOM nodes). `parentRef` is the scroll container below; `estimateSize`
  // just needs to be close (see readRowHeightPx), `measureElement` corrects
  // it per row after the first paint.
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [rowHeightPx] = useState(readRowHeightPx);
  const virtualizer = useVirtualizer({
    count: searching ? 0 : rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeightPx,
    overscan: 12,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  // Scroll the active/selected row into view: the keyboard cursor moving
  // past the visible window, and a selection change from elsewhere (the
  // back/forward jump list, or picking a search hit and clearing the
  // query) — both used to be a no-op because every row was already
  // mounted DOM; virtualised, the target row may not even be rendered.
  useEffect(() => {
    if (searching) return;
    virtualizer.scrollToIndex(Math.min(cursor, Math.max(rows.length - 1, 0)), { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, searching]);

  const scrolledForSelection = useRef("");
  useEffect(() => {
    if (searching) return;
    const target = sel.kind === "module" && sel.moduleId !== undefined
      ? `m:${sel.moduleId}`
      : sel.fn !== undefined ? `f:${sel.fn}` : "";
    if (target === "" || target === scrolledForSelection.current) return;
    const idx = sel.kind === "module" && sel.moduleId !== undefined
      ? indexOfModuleRow(rows, Number(sel.moduleId))
      : sel.fn !== undefined ? indexOfFnRow(rows, sel.fn) : -1;
    // The row is not in the flattened array yet (its group/module is still
    // closed, or a just-opened module's functions have not loaded) — try
    // again once `rows` changes rather than giving up.
    if (idx < 0) return;
    scrolledForSelection.current = target;
    virtualizer.scrollToIndex(idx, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.kind, sel.moduleId, sel.fn, rows, searching]);

  // Nothing is selected on load, and fn 0 (the global function) has no
  // recorded source range — opening it returns 400, not a listing. Land on
  // the first module's FILE instead: the file view is the listing.
  //
  // Wait for segregation to settle first: while `seg.isLoading` is true,
  // `groups` is computed from `groupModulesSegregated(rows, null)`, which
  // FALLS BACK to `groupModules` — a different key scheme (`"app"` vs the
  // segregated `APP_KEY` `"seg:app"`, `ui/src/listing/modules.ts`). Firing
  // this effect against the fallback opens/selects the fallback's group
  // key; once the real segregation answer lands moments later, `groups` is
  // recomputed with the segregated keys and the guard above (`sel.kind !==
  // "none"`) stops the effect from ever running again — stranding the
  // analyst on a permanently-collapsed group in the tree they can see is
  // selected. Playwright regression: ui/e2e/smoke.spec.ts's "right-click"/
  // "back-forward"/"rename" steps all depend on the first group being open.
  useEffect(() => {
    if (sel.kind !== "none") return;
    if (seg.isLoading) return;
    const first = groups[0];
    const m = first?.modules[0];
    if (first === undefined || m === undefined) return;
    toggleGroup(first.key, true);
    toggleModule(`m:${m.id}`, true);
    select({ kind: "module", moduleId: String(m.id) });
    // `toggle*` are stable setState wrappers; `groups` is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, sel.kind, seg.isLoading]);

  const activate = (row: TreeRow): void => {
    if (row.kind === "group") toggleGroup(row.key);
    else if (row.kind === "module") {
      toggleModule(row.key);
      select({ kind: "module", moduleId: String(row.module.id) });
    } else if (row.kind === "nav") {
      // Following an arrow opens the TARGET screen in the centre pane, and
      // opens its own row in the tree so its arrows are one step away.
      toggleModule(`m:${row.to}`, true);
      select({ kind: "module", moduleId: String(row.to) });
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
  // The two search-hit lists used to hard-cap at 100 modules / 200
  // functions with no indication anything was cut (spec 26 L5). Modules are
  // a client-side filter over the whole already-fetched tree, so every
  // match is shown — `ResultTable` virtualises it, the cap bought nothing.
  // Functions come from the server's own paginated `search/functions`
  // (`SEARCH_PAGE_CAP`, `src/mcp/leads.ts`), which already reports
  // `truncated`/`total` honestly — that is what the bar below reads now,
  // never a client-invented number.
  const searchBody = ((): ReactNode => {
    const moduleHits = filterGroups(groups, query, labelOf)
      .flatMap((g) => g.modules.map((m) => ({ groupKey: g.key, group: g.label, module: m })));
    if (hits.isLoading && moduleHits.length === 0) return <Empty>searching…</Empty>;
    const rowsOut = hits.data?.rows ?? [];
    if (rowsOut.length === 0 && moduleHits.length === 0) return <Empty>nothing matches “{query}”</Empty>;
    return (
      <>
        {moduleHits.length > 0 && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 px-2 py-1 text-xs uppercase text-text-muted">modules ({moduleHits.length})</div>
            <ResultTable
              data={moduleHits}
              getRowId={(h) => `sm:${h.module.id}`}
              rowProps={(h) => ({ "data-module": h.module.id, title: h.group })}
              rowClassName={(h) =>
                sel.kind === "module" && sel.moduleId === String(h.module.id) ? "border-l-2 border-l-accent bg-surface-2" : ""
              }
              onRowClick={(h) => {
                // Selecting a search hit must also open its group, or the
                // row this selection points at would never exist in the
                // flattened tree — `flattenTree` skips a closed group's
                // modules entirely, so the scroll-into-view effect below
                // would have no row to find once the query is cleared.
                toggleGroup(h.groupKey, true);
                select({ kind: "module", moduleId: String(h.module.id) });
              }}
              columns={[
                { id: "label", header: "module", accessorFn: (h) => labelOf(h.module), cell: (info) => info.getValue() },
                {
                  id: "id",
                  header: "id",
                  accessorFn: (h) => `module_${h.module.id}`,
                  cell: (info) => <span className="font-mono text-text-muted">{info.getValue() as string}</span>,
                },
              ]}
            />
          </div>
        )}
        {rowsOut.length > 0 && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 px-2 py-1 text-xs uppercase text-text-muted">functions ({hits.data?.total ?? rowsOut.length})</div>
            <ResultTable
              data={rowsOut}
              getRowId={(r) => `sf:${r.fn}`}
              rowElement="button"
              rowProps={(r) => ({ "data-fn": r.fn })}
              rowClassName={(r) => (sel.fn === r.fn ? "border-l-2 border-l-accent bg-surface-2" : "")}
              onRowClick={(r) => select({ kind: "fn", fn: r.fn, ...(r.name !== null ? { name: r.name } : {}) })}
              cap={
                hits.data
                  ? { shown: rowsOut.length, total: hits.data.total, truncated: hits.data.truncated, noun: "function" }
                  : undefined
              }
              columns={[
                { id: "name", header: "name", accessorFn: (r) => r.name ?? `fn ${r.fn}`, cell: (info) => <span className="font-mono">{info.getValue() as string}</span> },
                { id: "size", header: "size", accessorFn: (r) => r.size ?? 0, cell: (info) => <span className="tabular-nums text-text-muted">{(info.getValue() as number) || ""}</span> },
              ]}
            />
          </div>
        )}
      </>
    );
  })();

  /** One row's JSX — shared between the virtualizer's `getVirtualItems()`
   *  loop and (were it ever needed) a plain render; kept as a function
   *  rather than inlined so the group/module/fn cases read the same as
   *  before virtualisation. */
  const renderRow = (row: TreeRow, i: number): ReactNode => {
    const active = i === Math.min(cursor, rows.length - 1);
    if (row.kind === "group") {
      return (
        <div
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
        <RowMenu>
          <div
            data-module={row.module.id}
            className={rowClass(selected, active)}
            style={{ paddingLeft: `calc(0.5rem + ${row.depth} * 0.75rem)` }}
            onClick={() => { setCursor(i); activate(row); }}
            title={segById.get(row.module.id)?.path ?? row.module.file}
          >
            <span className="font-mono text-text-muted">{row.open ? "v" : ">"}</span>
            <span className="truncate">{labelOf(row.module)}</span>
            <span className="shrink-0 font-mono text-xs text-text-muted opacity-60">module_{row.module.id}</span>
            <span className="ml-auto shrink-0 tabular-nums text-text-muted">{row.count}</span>
          </div>
        </RowMenu>
      );
    }
    if (row.kind === "nav") {
      return (
        <div
          data-nav-from={row.from}
          data-nav-to={row.to}
          data-nav-confidence={row.confidence}
          className={clsx(rowClass(false, active), row.confidence === "by-name" && "italic opacity-70")}
          style={{ paddingLeft: `calc(0.5rem + ${row.depth} * 0.75rem)` }}
          onClick={() => { setCursor(i); activate(row); }}
          title={row.confidence === "by-name" ? `navigates to ${row.label} (by-name candidate, not a proven edge)` : `navigates to ${row.label} (resolved by the points-to index)`}
        >
          <span className={clsx("font-mono text-text-muted", row.confidence === "by-name" && "border-b border-dashed border-current")}>-&gt;</span>
          <span className="truncate">{row.label}</span>
          <span className="ml-auto shrink-0 font-mono text-xs text-text-muted opacity-60">{row.confidence === "by-name" ? "by-name" : "resolved"}</span>
        </div>
      );
    }
    const selected = sel.fn === row.row.fn && sel.kind !== "module";
    return (
      <RowMenu>
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
  };

  /** The empty/loading states that replace the whole tree — computed once
   *  so both the status line and the "is there anything to virtualise at
   *  all" check below read the same verdict. `null` means "render the
   *  virtualised rows". */
  const treeStatus = ((): ReactNode | null => {
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
    return null;
  })();

  const body = searching
    ? searchBody
    : (treeStatus ?? (
      <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (row === undefined) return null;
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
            >
              {renderRow(row, item.index)}
            </div>
          );
        })}
      </div>
    ));

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(v) => {
        setTab(v);
        if (v === "leads") setLeadsWanted(true);
      }}
      className="flex h-full min-w-0 flex-col bg-surface"
    >
      <PaneHeader>
        <Tabs.List className="flex w-full gap-1">
          <Tabs.Trigger value="modules" className={tabClass}>Modules</Tabs.Trigger>
          <Tabs.Trigger value="leads" className={tabClass}>Leads</Tabs.Trigger>
        </Tabs.List>
      </PaneHeader>
      <Tabs.Content value="modules" className="min-h-0 flex-1 outline-none">
        <div
          ref={parentRef}
          role="tree"
          aria-label="module tree"
          tabIndex={0}
          onKeyDown={onKeyDown}
          data-tree="modules"
          className={
            searching
              ? "flex h-full min-h-0 flex-col outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
              : "hbc-scroll h-full overflow-auto py-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
          }
        >
          {body}
        </div>
        {!searching && modules.data?.truncated === true && (
          <div className="border-t border-border px-2 py-1 text-xs text-text-muted">
            module list truncated — showing the first {modules.data?.rows.length ?? 0} of {modules.data?.total ?? 0}
          </div>
        )}
      </Tabs.Content>
      <Tabs.Content value="leads" className="flex min-h-0 flex-1 flex-col outline-none">
        {leads.data === undefined ? (
          <Empty>scanning the bundle for leads…</Empty>
        ) : (
          <ResultTable
            data={leads.data.groups.flatMap((g) => g.leads.map((l) => ({ cls: g.class, ...l })))}
            getRowId={(l) => l.evidence}
            rowElement="button"
            rowProps={(l) => (l.fn !== null ? { "data-fn": l.fn } : {})}
            rowClassName={(l) => (l.fn !== null && l.fn === sel.fn ? "border-l-2 border-l-accent bg-surface-2" : "")}
            onRowClick={(l) => {
              if (l.fn !== null) select({ kind: "fn", fn: l.fn, ...(l.name !== null ? { name: l.name } : {}) });
            }}
            emptyMessage="no leads found"
            columns={[
              { id: "class", header: "class", accessorFn: (l) => l.cls, cell: (info) => <span className="uppercase text-text-muted">{info.getValue() as string}</span> },
              { id: "name", header: "name", accessorFn: (l) => l.name ?? l.evidence, cell: (info) => <span className="font-mono">{info.getValue() as string}</span> },
              { id: "detail", header: "detail", accessorFn: (l) => l.detail, cell: (info) => <span className="text-text-muted">{info.getValue() as string}</span> },
            ]}
          />
        )}
      </Tabs.Content>
    </Tabs.Root>
  );
}
