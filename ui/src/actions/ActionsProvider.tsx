// ui/src/actions/ActionsProvider.tsx — the one wrapper App.tsx mounts: it
// installs the keydown adapter (§3.2), hosts the Radix context menu (§3.3),
// renders whichever annotate dialog an action opened (§3.6 / landing 5) and
// shows the one-line status a write leaves behind.
import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ContextMenuHost } from "../components/ContextMenu.tsx";
import { FindingForm } from "../components/FindingForm.tsx";
import { RenameDialog } from "../components/RenameDialog.tsx";
import { CommentDialog } from "./CommentDialog.tsx";
import { KeymapHelp } from "../components/KeymapHelp.tsx";
import { SettingsDialog } from "../components/SettingsDialog.tsx";
import { HistoryPane } from "../panes/HistoryPane.tsx";
import { installKeymapListener } from "./keys.ts";
import { setQueryClient } from "./registry.ts";
import { closeDialog, setOverlay, setStatus, useActionsState, type DialogState } from "./store.ts";

/** Spec 26 L6: `history/{target}` is keyed by the same annotation target
 *  every write already uses (`fn:N`/`mod:N`) — not the finding rid — so a
 *  target is only derivable from a selection that carries an `fn` or a
 *  `moduleId` (`hasListingTarget` in src/ui-core/actions.ts gates
 *  `view.history` on exactly that). `null` = no target, closes the dialog. */
function historyTargetFor(selection: DialogState["selection"]): string | null {
  if (selection.fn !== undefined) return `fn:${selection.fn}`;
  if (selection.moduleId !== undefined) return `mod:${selection.moduleId}`;
  return null;
}

const STATUS_MS = 6000;

function StatusToast(): ReactNode {
  const { status, pendingChord } = useActionsState();
  useEffect(() => {
    if (status === null) return undefined;
    const t = setTimeout(() => setStatus(null), STATUS_MS);
    return () => clearTimeout(t);
  }, [status]);
  if (status === null && pendingChord === "") return null;
  return (
    <div className="pointer-events-none fixed right-3 bottom-3 z-50 flex flex-col items-end gap-1">
      {pendingChord !== "" && (
        <div className="rounded-ui border border-accent bg-surface-2 px-2 py-1 font-mono text-xs text-text">{pendingChord}…</div>
      )}
      {status !== null && (
        <div className="max-w-[min(35rem,80vw)] rounded-ui border border-border bg-surface-2 px-2 py-1 text-xs text-text">{status}</div>
      )}
    </div>
  );
}

function Dialogs(): ReactNode {
  const { dialog } = useActionsState();
  if (dialog.kind === "none") return null;
  // Spec 26 L6: `history/{target}` — a target string, not an `fn`, so this
  // is checked before the fn-required gate below (a module selection has
  // no `fn` at all).
  if (dialog.kind === "history") {
    const target = historyTargetFor(dialog.selection);
    if (target === null) {
      setStatus("no history for this selection");
      closeDialog();
      return null;
    }
    return <HistoryPane target={target} onClose={closeDialog} />;
  }
  const fn = dialog.selection.fn;
  // Spec 26 L6: a lead promoted via `finding.fromLead` may have no owning
  // `fn` at all (`SinkLead.fn` is `number | null` for a string-only hit) —
  // `FindingForm` itself renders the "no owning function" case, so this
  // path skips the generic fn-required gate below.
  if (dialog.kind === "finding" && dialog.selection.kind === "lead") {
    return <FindingForm fn={fn ?? -1} lead={dialog.selection} />;
  }
  if (fn === undefined) {
    setStatus("select a function first");
    closeDialog();
    return null;
  }
  // The clicked TOKEN, when the selection is an identifier: `RenameDialog`
  // resolves it to a `reg:F:R` target via `/api/fn/{fn}/locals`.
  if (dialog.kind === "rename") {
    const ident = dialog.selection.kind === "identifier" ? dialog.selection.name : undefined;
    return <RenameDialog fn={fn} {...(ident !== undefined ? { ident } : {})} />;
  }
  if (dialog.kind === "comment") return <CommentDialog fn={fn} />;
  return <FindingForm fn={fn} />;
}

/** The two shell-wide overlays (`project.shortcuts` / `project.settings`).
 *  They live here, not in App.tsx, so the layout file stays untouched. */
function Overlays(): ReactNode {
  const { overlay } = useActionsState();
  if (overlay === "shortcuts") return <KeymapHelp onClose={() => setOverlay("none")} />;
  if (overlay === "settings") return <SettingsDialog onClose={() => setOverlay("none")} />;
  return null;
}

export function ActionsProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const qc = useQueryClient();
  setQueryClient(qc);
  useEffect(() => installKeymapListener(), []);
  return (
    <ContextMenuHost>
      {children}
      <Dialogs />
      <Overlays />
      <StatusToast />
    </ContextMenuHost>
  );
}
