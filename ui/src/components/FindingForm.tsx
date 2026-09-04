// ui/src/components/FindingForm.tsx — spec 22 §3.6's "Add finding" form,
// pre-filled from the selection. The body is `McpTools.RecordFindingInput`
// (src/mcp/tools.ts): `{ class, location:{fn}, claim, evidence[], prov }`.
//
// Truth rule 1 (spec 17 §14): a finding needs at least one evidence ref that
// RESOLVES, so the form seeds `fn:<selected fn>` (a ref kind the artifact
// resolver knows, alongside `reg:F:R`, `sid:N`, `mod:N`) and, when the server
// still refuses, shows the server's own reason VERBATIM instead of a
// friendly paraphrase — the refusal text is the only thing that says what to
// fix, and a candidate finding that never resolves must stay refused.
import { useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, ErrorNote, areaClass, fieldClass, labelClass } from "../actions/Modal.tsx";
import { ToolError, recordFinding } from "../actions/writes.ts";
import { invalidateFn, setQueryClient } from "../actions/registry.ts";
import { closeDialog, setStatus } from "../actions/store.ts";
import { useContextResource } from "../hooks.ts";
import { displayName } from "../actions/names.ts";
import type { Severity } from "../contracts.ts";
import { ToolButton } from "./primitives.tsx";

const SEVERITIES: readonly Severity[] = ["critical", "high", "med", "low"];

export function FindingForm({ fn }: { readonly fn: number }): ReactNode {
  const qc = useQueryClient();
  setQueryClient(qc);
  const ctx = useContextResource(fn);
  const name = displayName(ctx.data?.metadata) ?? `fn${fn}`;

  const [claim, setClaim] = useState("");
  const [severity, setSeverity] = useState<Severity>("med");
  const [evidenceRef, setEvidenceRef] = useState(`fn:${fn}`);
  const [note, setNote] = useState("");
  const [cwe, setCwe] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (claim.trim() === "") return setError("a claim is required");
    if (evidenceRef.trim() === "") return setError("at least one evidence ref is required (e.g. fn:123, sid:45, mod:9)");
    setBusy(true);
    setError(null);
    try {
      const res = await recordFinding({
        class: severity,
        location: { fn },
        claim: claim.trim(),
        evidence: [{ ref: evidenceRef.trim(), role: "site", ...(note.trim() !== "" ? { note: note.trim() } : {}) }],
        ...(cwe.trim() !== "" ? { cwe: cwe.trim() } : {}),
      });
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
      title="Add finding"
      subtitle={<>on <span className="font-mono">fn:{fn}</span> {name} · candidate until its evidence resolves</>}
      onClose={closeDialog}
    >
      <form onSubmit={(e) => void submit(e)}>
        <label className={labelClass} htmlFor="hbc-finding-claim">claim</label>
        <textarea id="hbc-finding-claim" className={areaClass} value={claim} onChange={(e) => setClaim(e.target.value)} />
        <div className="grid grid-cols-2 gap-2 pt-2">
          <div>
            <label className={labelClass} htmlFor="hbc-finding-sev">class / severity</label>
            <select
              id="hbc-finding-sev"
              className={fieldClass}
              value={severity}
              onChange={(e) => setSeverity(e.target.value as Severity)}
            >
              {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="hbc-finding-cwe">CWE (optional)</label>
            <input id="hbc-finding-cwe" className={fieldClass} value={cwe} onChange={(e) => setCwe(e.target.value)} placeholder="CWE-79" />
          </div>
        </div>
        <div className="pt-2">
          <label className={labelClass} htmlFor="hbc-finding-ref">evidence ref (fn: / reg: / sid: / mod:)</label>
          <input
            id="hbc-finding-ref"
            className={`${fieldClass} font-mono`}
            value={evidenceRef}
            onChange={(e) => setEvidenceRef(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="pt-2">
          <label className={labelClass} htmlFor="hbc-finding-note">evidence note (optional)</label>
          <input id="hbc-finding-note" className={fieldClass} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {error !== null && <ErrorNote>{error}</ErrorNote>}
        <div className="flex justify-end gap-2 pt-3">
          <ToolButton onClick={closeDialog} type="button">Cancel</ToolButton>
          <ToolButton type="submit" active disabled={busy}>{busy ? "recording..." : "Record finding"}</ToolButton>
        </div>
      </form>
    </Modal>
  );
}
