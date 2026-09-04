// ui/src/components/RenameDialog.tsx — `annotate.rename` (spec 22 landing 5:
// "rename-across-references ... with affected-reference preview"). The count
// shown before confirm is real: callers from `/api/fn/{fn}/callers` plus the
// xref rows `/api/fn/{fn}/context` carries, which is exactly what the rename
// will re-label in the listing.
//
// The write is `POST /api/tools/set-name` with a STRING target, the same call
// an MCP client makes, so it lands in the log and the export. The target is
// `reg:<fn>:<reg>` when the right-click landed on one of the function's own
// nameable locals (resolved through `GET /api/fn/{fn}/locals` by
// `src/ui-core/rename-target.ts`) and `fn:<n>` otherwise — the subtitle always
// states which, so a fallback to the enclosing function can never mislead.
import { useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, ErrorNote, fieldClass, labelClass } from "../actions/Modal.tsx";
import { ToolError, setName } from "../actions/writes.ts";
import { invalidateFn, setQueryClient } from "../actions/registry.ts";
import { closeDialog, setStatus } from "../actions/store.ts";
import { useContextResource, useLocals, useWhoCalls } from "../hooks.ts";
import { renameTargetFor } from "@ui-core/rename-target.ts";
import { displayName } from "../actions/names.ts";
import { ToolButton } from "./primitives.tsx";

export function RenameDialog({ fn, ident }: { readonly fn: number; readonly ident?: string }): ReactNode {
  const qc = useQueryClient();
  setQueryClient(qc);
  const ctx = useContextResource(fn);
  const callers = useWhoCalls(fn);
  const locals = useLocals(fn);
  const resolved = renameTargetFor(fn, ident, locals.data?.rows);
  const fnName = displayName(ctx.data?.metadata) ?? `fn${fn}`;
  // The locals listing is a second request; until it SETTLES, a clicked
  // token is neither confirmed a local nor confirmed not one — show the
  // token and say nothing about a fallback (which would flicker and then be
  // wrong). `locals.isPending` (not `locals.data === undefined`) is what
  // actually settles: a fn whose locals 400 (no `--hbc`, spec 17's
  // live-verb constraint) never gets `data`, so checking `data === undefined`
  // left this stuck "pending" forever and the dialog could never submit —
  // an errored query still falls back to renaming the enclosing function,
  // same as "not a nameable local".
  const pending = ident !== undefined && locals.isPending;
  const current = resolved.kind === "reg" || pending ? (ident ?? fnName) : fnName;
  // `null` until the field is edited, so the suggested name follows `current`
  // once the listing lands rather than freezing at the first render's guess.
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? current;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const callerCount = callers.data?.total ?? 0;
  const ctxRefs = (ctx.data?.callers?.total ?? 0) + (ctx.data?.callees?.total ?? 0);
  const unknown = callers.data?.unknownInScope ?? 0;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (name.trim() === "") return setError("a name is required");
    if (pending) return setError("still resolving what that identifier is — try again in a moment");
    setBusy(true);
    try {
      const res = await setName(resolved.target, name.trim());
      invalidateFn(fn);
      setStatus(res.line);
      closeDialog();
    } catch (err) {
      setError(err instanceof ToolError ? err.reason : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={resolved.kind === "reg" || pending ? `Rename local ${current}` : `Rename ${current}`}
      subtitle={
        resolved.kind === "reg" ? (
          <>
            local of <span className="font-mono">fn:{fn}</span> · {resolved.uses} reference{resolved.uses === 1 ? "" : "s"} in this frame
            {" "}· target <span className="font-mono">{resolved.target}</span>
          </>
        ) : (
          <>
            {resolved.fellBack && !pending && <>“{resolved.token}” is not a nameable local here — renaming the enclosing function · </>}
            {callerCount} call site{callerCount === 1 ? "" : "s"} · {ctxRefs} xref{ctxRefs === 1 ? "" : "s"} in context
            {unknown > 0 && <> · {unknown} unknown in scope</>} · target <span className="font-mono">{resolved.target}</span>
          </>
        )
      }
      onClose={closeDialog}
    >
      <form onSubmit={(e) => void submit(e)}>
        <label className={labelClass} htmlFor="hbc-rename-input">new name</label>
        <input
          id="hbc-rename-input"
          className={fieldClass}
          value={name}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        {error !== null && <ErrorNote>{error}</ErrorNote>}
        <div className="flex justify-end gap-2 pt-3">
          <ToolButton onClick={closeDialog} type="button">Cancel</ToolButton>
          <ToolButton type="submit" active disabled={busy}>{busy ? "renaming..." : "Rename"}</ToolButton>
        </div>
      </form>
    </Modal>
  );
}
