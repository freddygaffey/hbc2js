// ui/src/components/KeymapHelp.tsx — the "Keyboard shortcuts" cheat-sheet
// (docs/UI.md, "Keyboard shortcuts"). It is a VIEW over the live keymap, not
// a second list: every row comes from `activeBindings()` (the resolved
// preset + overrides) joined against the action registry, so a rebind made
// in Settings shows here immediately and the three surfaces can never drift.
import type { ReactNode } from "react";
import { Modal } from "../actions/Modal.tsx";
import { activeBindings, registry, useKeymapConfig } from "../actions/registry.ts";
import { setOverlay } from "../actions/store.ts";
import { isMacPlatform } from "../actions/keys.ts";

/** How a chord is SHOWN. On macOS the presets' `Ctrl-` is what the Command
 *  key produces (ui/src/actions/keys.ts folds Meta into Ctrl), so the label
 *  says so rather than lying about a key Mac users never press. */
export function chordLabel(chord: string, mac: boolean): string {
  return mac ? chord.replace(/\bCtrl-/g, "⌘") : chord;
}

/** action id -> every chord bound to it, joined for display. */
export function bindingRows(bindings: Record<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [chord, id] of Object.entries(bindings)) {
    const list = out.get(id);
    if (list === undefined) out.set(id, [chord]);
    else list.push(chord);
  }
  return out;
}

export function KeymapHelp({ onClose }: { readonly onClose: () => void }): ReactNode {
  const config = useKeymapConfig();
  const mac = isMacPlatform();
  const byAction = bindingRows(activeBindings());
  const actions = registry.list();
  const groups = [...new Set(actions.map((a) => a.group))];

  return (
    <Modal
      title="Keyboard shortcuts"
      subtitle={
        <span>
          keymap preset <span className="font-mono text-text">{config.preset}</span> — change or rebind any of these in
          Settings
        </span>
      }
      onClose={onClose}
      wide
    >
      <div data-testid="keymap-help" className="hbc-scroll max-h-[60vh] overflow-auto">
        {groups.map((g) => (
          <div key={g} className="pb-3">
            <div className="pb-1 text-text-muted uppercase">{g}</div>
            <div className="grid grid-cols-2 gap-x-6">
              {actions
                .filter((a) => a.group === g)
                .map((a) => {
                  const chords = byAction.get(a.id) ?? [];
                  return (
                    <div key={a.id} data-shortcut={a.id} className="flex items-center justify-between gap-3 py-0.5">
                      <span className="truncate text-text">{a.title}</span>
                      <span data-shortcut-chord className="shrink-0 font-mono text-text-muted">
                        {chords.length === 0 ? "—" : chords.map((c) => chordLabel(c, mac)).join("  /  ")}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2 border-t border-border pt-2">
        <button type="button" className="h-7 rounded-ui border border-border px-2" onClick={() => setOverlay("settings")}>
          Settings…
        </button>
        <button type="button" className="h-7 rounded-ui border border-accent px-2 text-accent" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
