// ui/src/panes/TopBar.tsx — project name, search box (placeholder), density
// and theme toggles, command-palette trigger (stub, spec 22 §3.1).
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { ToolButton } from "../components/primitives.tsx";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { API_BASE, USING_MOCK } from "../api.ts";

export function TopBar({ onOpenPalette }: { readonly onOpenPalette: () => void }): ReactNode {
  const { preset, presets, setPreset, density, setDensity } = useTheme();
  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
      <span className="font-mono text-sm text-text">hbc2js</span>
      <span className="truncate text-xs text-text-muted" title={USING_MOCK ? "mock adapter" : API_BASE}>
        {USING_MOCK ? "no project (mock data)" : API_BASE}
      </span>
      <input
        type="search"
        placeholder="Search functions and source (stub)"
        className="ml-2 h-7 w-80 rounded-ui border border-border bg-surface-2 px-2 text-xs text-text outline-none placeholder:text-text-muted focus-visible:border-accent"
      />
      <div className="ml-auto flex items-center gap-2">
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
        <ToolButton tip="Command palette (Cmd/Ctrl-K)" onClick={onOpenPalette}>
          <span className="font-mono">&#x2318;K</span>
        </ToolButton>
      </div>
    </header>
  );
}
