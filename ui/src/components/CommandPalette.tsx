// ui/src/components/CommandPalette.tsx — spec 22 §3.1's third view over the
// action registry (the other two are the context menu and the keymap). The
// item list is `paletteItems(ctx, registry)`, so it is exactly the set of
// actions enabled for the current selection, each with its chord; the only
// non-registry rows are the two shell PREFERENCES (density, theme), which
// are not commands over the project and deliberately live here.
import { Command } from "cmdk";
import { useState, type ReactNode } from "react";
import { paletteItems } from "@ui-core/actions.ts";
import { actionContext, keymap, registry, runAction } from "../actions/registry.ts";
import { setPaletteOpen, useActionsState } from "../actions/store.ts";
import { useSelection } from "../state/selection.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";

const PREF_TOGGLE_DENSITY = "pref.density";
const PREF_TOGGLE_THEME = "pref.theme";

export function CommandPalette({
  open, onOpenChange,
}: { readonly open: boolean; readonly onOpenChange: (v: boolean) => void }): ReactNode {
  const { density, setDensity, preset, setPreset, presets } = useTheme();
  const [value, setValue] = useState("");
  const selection = useSelection();
  const storeOpen = useActionsState().paletteOpen;
  const isOpen = open || storeOpen;

  const setOpen = (v: boolean): void => {
    onOpenChange(v);
    setPaletteOpen(v);
  };

  const items = paletteItems(actionContext(selection), registry);

  const run = (id: string): void => {
    setOpen(false);
    if (id === PREF_TOGGLE_DENSITY) return setDensity(density === "compact" ? "comfortable" : "compact");
    if (id === PREF_TOGGLE_THEME) return setPreset(presets.find((p) => p !== preset) ?? preset);
    runAction(id, selection);
  };

  return (
    <Command.Dialog
      open={isOpen}
      onOpenChange={setOpen}
      label="Command palette"
      data-hbc-keys="off"
      className="fixed top-24 left-1/2 z-50 w-[min(560px,90vw)] -translate-x-1/2 rounded-ui border border-border bg-surface text-text"
    >
      <Command.Input
        value={value}
        onValueChange={setValue}
        placeholder="Run a command"
        className="h-9 w-full border-b border-border bg-transparent px-3 text-xs outline-none placeholder:text-text-muted"
      />
      <Command.List className="max-h-72 overflow-auto p-1">
        <Command.Empty className="p-3 text-xs text-text-muted">No matching action.</Command.Empty>
        {items.map((it) => (
          <Command.Item
            key={it.id}
            value={`${it.title} ${it.id}`}
            onSelect={() => run(it.id)}
            className="flex h-7 cursor-pointer items-center justify-between rounded-ui px-2 text-xs data-[selected=true]:bg-surface-2"
          >
            <span>{it.title}</span>
            <span className="font-mono text-text-muted">{keymap.chordFor(it.id) ?? ""}</span>
          </Command.Item>
        ))}
        <Command.Item
          value="Toggle density"
          onSelect={() => run(PREF_TOGGLE_DENSITY)}
          className="flex h-7 cursor-pointer items-center justify-between rounded-ui px-2 text-xs data-[selected=true]:bg-surface-2"
        >
          <span>Toggle density</span>
          <span className="text-text-muted">{density}</span>
        </Command.Item>
        <Command.Item
          value="Toggle theme"
          onSelect={() => run(PREF_TOGGLE_THEME)}
          className="flex h-7 cursor-pointer items-center justify-between rounded-ui px-2 text-xs data-[selected=true]:bg-surface-2"
        >
          <span>Toggle theme</span>
          <span className="text-text-muted">{preset}</span>
        </Command.Item>
      </Command.List>
    </Command.Dialog>
  );
}
