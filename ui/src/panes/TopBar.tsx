// ui/src/panes/TopBar.tsx — project name, breadcrumbs (module › fn), the
// function search box, density and theme toggles, command-palette trigger.
//
// Back/forward are the jump list's two buttons (ui/src/state/selection.ts).
// They dispatch `navigate.back`/`navigate.forward` through `runAction`, NOT
// `back()`/`forward()` directly, so the buttons and the keymap are the same
// one path through src/ui-core's registry — and their tooltips read the chord
// out of the live keymap rather than hard-coding it.
//
// Search is `GET /api/search/functions` (spec 22 §3.5). The query lives in
// ui/src/listing/search-store.ts, not in App state, because the left pane
// filters on the same string; Enter selects the first hit, the dropdown
// shows at most SEARCH_ROWS of them.
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useRef, useState, type ReactNode } from "react";
import { ToolButton } from "../components/primitives.tsx";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { API_BASE, USING_MOCK } from "../api.ts";
import { useFn, useModule, useSearchFunctions } from "../hooks.ts";
import { setQuery, useQueryText } from "../listing/search-store.ts";
import { jumpList, select, useJumpState, useSelection } from "../state/selection.ts";
import { keymap, runAction } from "../actions/registry.ts";

/** The dropdown never grows past this many rows (spec 22 §2: bounded lists). */
export const SEARCH_ROWS = 50;

/** The jump-list arrows. Disabled state comes from the store, so a fresh
 *  page (nothing visited yet) shows them greyed rather than silently doing
 *  nothing when clicked. */
function JumpButtons(): ReactNode {
  const { canBack, canForward } = useJumpState();
  const { entries, cursor } = jumpList();
  const where = `${cursor + 1} of ${entries.length}`;
  const tip = (what: string, id: string): string => {
    const chord = keymap.chordFor(id);
    return `${what}${chord === undefined ? "" : ` (${chord})`} — ${where}`;
  };
  return (
    <div className="flex shrink-0 items-center gap-1" data-testid="jump-buttons">
      <ToolButton
        aria-label="back"
        data-action="navigate.back"
        disabled={!canBack}
        tip={tip("Back", "navigate.back")}
        className="disabled:opacity-40"
        onClick={() => runAction("navigate.back")}
      >
        <span aria-hidden>&#8592;</span>
      </ToolButton>
      <ToolButton
        aria-label="forward"
        data-action="navigate.forward"
        disabled={!canForward}
        tip={tip("Forward", "navigate.forward")}
        className="disabled:opacity-40"
        onClick={() => runAction("navigate.forward")}
      >
        <span aria-hidden>&#8594;</span>
      </ToolButton>
    </div>
  );
}

function Breadcrumbs(): ReactNode {
  const sel = useSelection();
  const fn = sel.fn;
  const meta = useFn(fn ?? -1);
  const moduleId = meta.data?.module ?? null;
  const mod = useModule(moduleId ?? -1);
  if (fn === undefined) return <span className="truncate text-xs text-text-muted">no selection</span>;
  const file = mod.data?.file ?? meta.data?.file ?? null;
  const name = meta.data?.overlayName ?? meta.data?.name ?? `fn ${fn}`;
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs text-text-muted" data-testid="breadcrumbs">
      <span className="truncate" title={file ?? undefined}>{file ?? (moduleId !== null ? `module ${moduleId}` : "—")}</span>
      <span aria-hidden>›</span>
      <span className="truncate font-mono text-text">{name}</span>
    </span>
  );
}

export function TopBar({ onOpenPalette }: { readonly onOpenPalette: () => void }): ReactNode {
  const { preset, presets, setPreset, density, setDensity } = useTheme();
  const query = useQueryText();
  const hits = useSearchFunctions(query);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const rows = (hits.data?.rows ?? []).slice(0, SEARCH_ROWS);

  const choose = (fn: number, name: string | null): void => {
    select({ kind: "fn", fn, ...(name !== null ? { name } : {}) });
    setOpen(false);
    input.current?.blur();
  };

  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
      <span className="font-mono text-sm text-text">hbc2js</span>
      <span className="truncate text-xs text-text-muted" title={USING_MOCK ? "mock adapter" : API_BASE}>
        {USING_MOCK ? "no project (mock data)" : API_BASE}
      </span>
      <div className="relative ml-2">
        <input
          ref={input}
          type="search"
          value={query}
          placeholder="Search functions"
          aria-label="search functions"
          data-testid="search-functions"
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const first = rows[0];
              if (first !== undefined) choose(first.fn, first.name);
            } else if (e.key === "Escape") {
              setOpen(false);
              input.current?.blur();
            }
          }}
          className="h-7 w-80 rounded-ui border border-border bg-surface-2 px-2 text-xs text-text outline-none placeholder:text-text-muted focus-visible:border-accent"
        />
        {open && query.trim() !== "" && (
          <div className="hbc-scroll absolute left-0 top-8 z-20 max-h-80 w-80 overflow-auto rounded-ui border border-border bg-surface p-1 text-xs">
            {hits.isLoading && <div className="px-2 py-1 text-text-muted">searching…</div>}
            {!hits.isLoading && rows.length === 0 && <div className="px-2 py-1 text-text-muted">no matches</div>}
            {rows.map((r) => (
              <button
                key={r.fn}
                type="button"
                data-fn={r.fn}
                onMouseDown={(e) => { e.preventDefault(); choose(r.fn, r.name); }}
                className="flex h-7 w-full items-center gap-2 rounded-ui px-2 text-left text-text-muted hover:bg-surface-2 hover:text-text"
              >
                <span className="truncate font-mono">{r.name ?? `fn ${r.fn}`}</span>
                <span className="ml-auto shrink-0 tabular-nums">{r.size ?? ""}</span>
              </button>
            ))}
            {(hits.data?.total ?? 0) > rows.length && (
              <div className="px-2 py-1 text-text-muted">{hits.data!.total - rows.length} more not shown</div>
            )}
          </div>
        )}
      </div>
      <div className="ml-3"><JumpButtons /></div>
      <div className="min-w-0 flex-1"><Breadcrumbs /></div>
      <div className="flex shrink-0 items-center gap-2">
        <ToolButton tip="Density (spacing + type scale)" onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")}>
          {density}
        </ToolButton>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <ToolButton tip="Theme preset (ui/theme.json)">{preset}</ToolButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content sideOffset={4} align="end" className="min-w-32 rounded-ui border border-border bg-surface p-1 text-xs text-text">
              {presets.map((p) => (
                <DropdownMenu.Item
                  key={p}
                  onSelect={() => setPreset(p)}
                  className="flex h-7 cursor-pointer items-center rounded-ui px-2 outline-none data-[highlighted]:bg-surface-2"
                >
                  {p}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <ToolButton aria-label="settings" data-action="project.settings" tip="Settings (theme, density, key bindings)" onClick={() => runAction("project.settings")}>
          <span aria-hidden>&#9881;</span>
        </ToolButton>
        <ToolButton aria-label="keyboard shortcuts" data-action="project.shortcuts" tip="Keyboard shortcuts (?)" onClick={() => runAction("project.shortcuts")}>
          <span aria-hidden>?</span>
        </ToolButton>
        <ToolButton tip="Command palette (Cmd/Ctrl-K)" onClick={onOpenPalette}>
          <span className="font-mono">&#x2318;K</span>
        </ToolButton>
      </div>
    </header>
  );
}
