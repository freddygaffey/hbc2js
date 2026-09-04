// ui/src/components/RenameDialog.tsx — `annotate.rename` (spec 22 landing 5:
// "rename-across-references ... with affected-reference preview"). The count
// shown before confirm is real: callers from `/api/fn/{fn}/callers` plus the
// xref rows `/api/fn/{fn}/context` carries, which is exactly what the rename
// will re-label in the listing.
//
// The write is `POST /api/tools/set-name` with a STRING target (`fn:7992`),
// the same call an MCP client makes, so it lands in the log and the export.
import { useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, ErrorNote, fieldClass, labelClass } from "../actions/Modal.tsx";
import { ToolError, fnTarget, setName } from "../actions/writes.ts";
import { invalidateFn, setQueryClient } from "../actions/registry.ts";
import { closeDialog, setStatus } from "../actions/store.ts";
import { useContextResource, useWhoCalls } from "../hooks.ts";
import { displayName } from "../actions/names.ts";
import { ToolButton } from "./primitives.tsx";

export function RenameDialog({ fn }: { readonly fn: number }): ReactNode {
  const qc = useQueryClient();
  setQueryClient(qc);
  const ctx = useContextResource(fn);
  const callers = useWhoCalls(fn);
  const current = displayName(ctx.data?.metadata) ?? `fn${fn}`;
  const [name, setNameText] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const callerCount = callers.data?.total ?? 0;
  const ctxRefs = (ctx.data?.callers?.total ?? 0) + (ctx.data?.callees?.total ?? 0);
  const unknown = callers.data?.unknownInScope ?? 0;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (name.trim() === "") return setError("a name is required");
    setBusy(true);
    try {
      const res = await setName(fnTarget(fn), name.trim());
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
      title={`Rename ${current}`}
      subtitle={
        <>
          {callerCount} call site{callerCount === 1 ? "" : "s"} · {ctxRefs} xref{ctxRefs === 1 ? "" : "s"} in context
          {unknown > 0 && <> · {unknown} unknown in scope</>} · target <span className="font-mono">{fnTarget(fn)}</span>
        </>
      }
      onClose={closeDialog}
    >
      <form onSubmit={(e) => void submit(e)}>
        <label className={labelClass} htmlFor="hbc-rename-input">new name</label>
        <input
          id="hbc-rename-input"
          className={fieldClass}
          value={name}
          onChange={(e) => setNameText(e.target.value)}
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
