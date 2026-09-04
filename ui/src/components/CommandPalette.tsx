// ui/src/components/CommandPalette.tsx — STUB. Spec 22 §3.1 makes the
// palette one of three views over the action registry (landing 4); this
// shell ships the surface (Cmd/Ctrl-K, `:`), with a hard-coded item list
// standing in for the registry so the registry lands as a drop-in.
import { Command } from "cmdk";
import { useEffect, useState, type ReactNode } from "react";
import { useTheme } from "../theme/ThemeProvider.tsx";

const ITEMS: readonly { readonly id: string; readonly title: string; readonly hint: string }[] = [
  { id: "rename", title: "Rename symbol", hint: "F2 / cr" },
  { id: "comment", title: "Add comment", hint: "gc" },
  { id: "goto-def", title: "Go to definition", hint: "gd" },
  { id: "xrefs", title: "Find xrefs", hint: "gr" },
  { id: "toggle-density", title: "Toggle density", hint: "" },
  { id: "toggle-theme", title: "Toggle theme", hint: "" },
];

export function CommandPalette({ open, onOpenChange }: { readonly open: boolean; readonly onOpenChange: (v: boolean) => void }): ReactNode {
  const { density, setDensity, preset, setPreset, presets } = useTheme();
  const [value, setValue] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const run = (id: string): void => {
    if (id === "toggle-density") setDensity(density === "compact" ? "comfortable" : "compact");
    if (id === "toggle-theme") setPreset(presets.find((p) => p !== preset) ?? preset);
    onOpenChange(false);
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      className="fixed top-24 left-1/2 z-50 w-[min(560px,90vw)] -translate-x-1/2 rounded-ui border border-border bg-surface text-text"
    >
      <Command.Input
        value={value}
        onValueChange={setValue}
        placeholder="Run a command (stub: the action registry lands in spec 22 landing 4)"
        className="h-9 w-full border-b border-border bg-transparent px-3 text-xs outline-none placeholder:text-text-muted"
      />
      <Command.List className="max-h-72 overflow-auto p-1">
        <Command.Empty className="p-3 text-xs text-text-muted">No matching action.</Command.Empty>
        {ITEMS.map((it) => (
          <Command.Item
            key={it.id}
            value={it.title}
            onSelect={() => run(it.id)}
            className="flex h-7 cursor-pointer items-center justify-between rounded-ui px-2 text-xs data-[selected=true]:bg-surface-2"
          >
            <span>{it.title}</span>
            <span className="text-text-muted">{it.hint}</span>
          </Command.Item>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
