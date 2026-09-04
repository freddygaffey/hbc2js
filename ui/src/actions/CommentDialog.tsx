// ui/src/actions/CommentDialog.tsx — `annotate.comment`. Body shape is
// `McpTools.AddCommentInput` (src/mcp/tools.ts): `{ target, body, prov }`,
// target a string like `fn:7992`. Optional `range` (a rendered line anchor)
// is filled in when the selection came from a listing line.
import { useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, ErrorNote, areaClass, labelClass } from "./Modal.tsx";
import { ToolError, addComment, fnTarget } from "./writes.ts";
import { invalidateFn, setQueryClient } from "./registry.ts";
import { closeDialog, setStatus } from "./store.ts";
import { ToolButton } from "../components/primitives.tsx";

export function CommentDialog({ fn }: { readonly fn: number }): ReactNode {
  const qc = useQueryClient();
  setQueryClient(qc);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (text.trim() === "") return setError("a comment body is required");
    setBusy(true);
    try {
      const res = await addComment(fnTarget(fn), text.trim());
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
    <Modal title="Add comment" subtitle={<>target <span className="font-mono">{fnTarget(fn)}</span></>} onClose={closeDialog}>
      <form onSubmit={(e) => void submit(e)}>
        <label className={labelClass} htmlFor="hbc-comment-body">comment</label>
        <textarea id="hbc-comment-body" className={areaClass} value={text} onChange={(e) => setText(e.target.value)} />
        {error !== null && <ErrorNote>{error}</ErrorNote>}
        <div className="flex justify-end gap-2 pt-3">
          <ToolButton onClick={closeDialog} type="button">Cancel</ToolButton>
          <ToolButton type="submit" active disabled={busy}>{busy ? "saving..." : "Add comment"}</ToolButton>
        </div>
      </form>
    </Modal>
  );
}
