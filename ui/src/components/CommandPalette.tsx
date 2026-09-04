// ui/src/components/CommandPalette.tsx — spec 22 §3.1's third view over the
// action registry (the other two are the context menu and the keymap). The
// item list is `paletteItems(ctx, registry)`, so it is exactly the set of
// actions enabled for the current selection, each with its chord; the only
// non-registry rows are the two shell PREFERENCES (density, theme), which
// are not commands over the project and deliberately live here.
//
// Bur 5 (docs/UI-BURS.md #5): the SAME dialog doubles as a vim-style ":"
// command line — no new component. `:` (`project.commandMode`, see the
// presets) opens it prefilled with ":"; while the query starts with ":" the
// list either shows a single synthetic row describing the parsed verb
// (`:fn 74`, `:mod 3`, `:goto name`, `:q`, `:set theme/keymap <preset>`) or,
// for a plain `:<partial-id>`, the action list fuzzy-filtered on id
// (`fuzzyMatchIds`, cmdk's own filtering is disabled via `shouldFilter` so
// this module controls exactly what shows).
import { Command } from "cmdk";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { paletteItems } from "@ui-core/actions.ts";
import { describeCommand, fuzzyMatchIds, isCommandQuery, parseCommand } from "@ui-core/commands.ts";
import { actionContext, keymap, registry, runAction, runCommand } from "../actions/registry.ts";
import { setPaletteOpen, useActionsState } from "../actions/store.ts";
import { useSelection } from "../state/selection.ts";
import { partnerPreset } from "../theme/apply.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";

const PREF_TOGGLE_DENSITY = "pref.density";
const PREF_TOGGLE_THEME = "pref.theme";
const COMMAND_ROW = "__command__";

export function CommandPalette({
  open, onOpenChange,
}: { readonly open: boolean; readonly onOpenChange: (v: boolean) => void }): ReactNode {
  const { density, setDensity, preset, setPreset } = useTheme();
  const [value, setValue] = useState("");
  const selection = useSelection();
  const { paletteOpen: storeOpen, paletteMode } = useActionsState();
  const isOpen = open || storeOpen;
  const wasOpen = useRef(false);

  // Opening in command mode (the ":" chord) prefills the query; every other
  // open (Ctrl-K/Ctrl-P, the palette action) starts blank, same as before.
  useEffect(() => {
    if (isOpen && !wasOpen.current) setValue(paletteMode === "command" ? ":" : "");
    wasOpen.current = isOpen;
  }, [isOpen, paletteMode]);

  const setOpen = (v: boolean): void => {
    onOpenChange(v);
    setPaletteOpen(v);
  };

  const isCmd = isCommandQuery(value);
  const parsed = isCmd ? parseCommand(value) : null;
  const verbDescription = parsed !== null ? describeCommand(parsed) : undefined;

  const items = paletteItems(actionContext(selection), registry);
  const matchedIds = isCmd && parsed?.kind === "action" ? new Set(fuzzyMatchIds(parsed.query, items.map((it) => it.id))) : null;
  const visibleItems = matchedIds === null ? items : items.filter((it) => matchedIds.has(it.id));

  const run = (id: string): void => {
    setOpen(false);
    if (id === PREF_TOGGLE_DENSITY) return setDensity(density === "compact" ? "comfortable" : "compact");
    if (id === PREF_TOGGLE_THEME) return setPreset(partnerPreset(preset));
    if (id === COMMAND_ROW) return runCommand(value);
    runAction(id, selection);
  };

  return (
    <Command.Dialog
      open={isOpen}
      onOpenChange={setOpen}
      label="Command palette"
      shouldFilter={!isCmd}
      data-hbc-keys="off"
      className="fixed top-24 left-1/2 z-50 w-[min(35rem,90vw)] -translate-x-1/2 rounded-ui border border-border bg-surface text-text"
    >
      <Command.Input
        value={value}
        onValueChange={setValue}
        placeholder={isCmd ? "Type a command… (:fn 74, :goto name, :q, :set theme dracula)" : "Run a command"}
        className="h-9 w-full border-b border-border bg-transparent px-3 text-xs outline-none placeholder:text-text-muted"
      />
      <Command.List className="max-h-72 overflow-auto p-1">
        <Command.Empty className="p-3 text-xs text-text-muted">No matching action.</Command.Empty>
        {isCmd && verbDescription !== undefined ? (
          <Command.Item
            key={COMMAND_ROW}
            value={COMMAND_ROW}
            onSelect={() => run(COMMAND_ROW)}
            className="flex h-7 cursor-pointer items-center justify-between rounded-ui px-2 text-xs data-[selected=true]:bg-surface-2"
          >
            <span>{verbDescription}</span>
            <span className="font-mono text-text-muted">Enter</span>
          </Command.Item>
        ) : (
          visibleItems.map((it) => (
            <Command.Item
              key={it.id}
              value={it.id}
              onSelect={() => run(it.id)}
              className="flex h-7 cursor-pointer items-center justify-between rounded-ui px-2 text-xs data-[selected=true]:bg-surface-2"
            >
              <span>{it.title}</span>
              <span className="font-mono text-text-muted">{keymap.chordFor(it.id) ?? ""}</span>
            </Command.Item>
          ))
        )}
        {!isCmd && (
          <>
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
          </>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
