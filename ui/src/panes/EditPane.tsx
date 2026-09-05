// ui/src/panes/EditPane.tsx — docs/specs/26-ui-full-ide.md L8: the attended
// "Edit & recompile" flow over `POST /api/tools/recompile-edit`
// (`recompile_edit`, docs/specs/17-mcp-harness.md §13).
//
// Three rules this pane exists to keep, all of them someone else's decision:
//
//  1. **Attended-only.** `recompile_edit` is the one operation that produces
//     a modified binary, so it is never one click away and never automatic:
//     the analyst types the edit, presses "Recompile", and then confirms a
//     second time. Workers cannot reach it at all — the server refuses a
//     worker provenance with a 403 before any sandbox is created (spec 23
//     §7, `src/ui-server/sandbox.ts`'s `refusalForProvenance`).
//  2. **Warning and watermark VERBATIM.** Both are rendered exactly as the
//     server sent them (`<pre>`, no truncation, no rewording, no icons in
//     place of words) — the same rule `ToolError.reason` already follows.
//     The UI never composes its own version of either string; if the
//     server's text changes, this pane's output changes with it.
//  3. **Cancel writes nothing.** Cancel is a pure client-side reset: it
//     never posts, so nothing is compiled, no `.hbcproj` row is written and
//     no sandbox is created (D30 §4's "text entry lives in a write dialog"
//     idiom, applied to a pane: the draft is not a document, it is a form).
//
// The sandbox itself is server-side and ephemeral (spec 21 §2.1): this pane
// only reports which sandbox ran the experiment and whether it was torn
// down, because a sandbox that outlived its experiment is a fact the
// operator must see rather than a detail to hide.
import { useState, type ReactNode } from "react";
import { Empty, PaneHeader, ToolButton } from "../components/primitives.tsx";
import { ToolError, recompileEdit, type RecompileEditResult } from "../actions/writes.ts";
import { setStatus } from "../actions/store.ts";

type Phase = "editing" | "confirming" | "running" | "done";

const textareaClass =
  "hbc-scroll h-48 w-full resize-none rounded-ui border border-border bg-surface-2 p-2 font-mono text-xs text-text outline-none placeholder:text-text-muted focus-visible:border-accent";
const verbatimClass = "whitespace-pre-wrap break-words rounded-ui border border-border bg-surface-2 p-2 font-mono text-xs";

function KeyVal({ k, v }: { readonly k: string; readonly v: string }): ReactNode {
  return (
    <div className="flex gap-2 px-3 py-0.5 text-xs">
      <span className="w-28 shrink-0 text-text-muted">{k}</span>
      <span className="break-all font-mono text-text">{v}</span>
    </div>
  );
}

export function EditPane({ fn }: { readonly fn: number }): ReactNode {
  const [source, setSource] = useState("");
  const [phase, setPhase] = useState<Phase>("editing");
  const [result, setResult] = useState<RecompileEditResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (fn < 0) return <Empty>select a function to edit and recompile</Empty>;

  const reset = (): void => {
    setPhase("editing");
    setResult(null);
    setError(null);
  };

  const cancel = (): void => {
    // Client-side only: nothing has been posted, so there is nothing to undo.
    setSource("");
    reset();
    setStatus("edit & recompile cancelled - nothing was compiled or written");
  };

  const run = async (): Promise<void> => {
    setPhase("running");
    setError(null);
    setResult(null);
    try {
      const r = await recompileEdit(fn, source);
      setResult(r);
      setPhase("done");
      setStatus(`recompiled fn:${fn} into a scratch copy (sandbox ${r.sandbox.id}, torn down: ${String(r.sandbox.tornDown)})`);
    } catch (e) {
      // The server's refusal, VERBATIM (a worker 403, a hermesc failure, a
      // missing toolchain) — it is the only thing that says what to fix.
      setError(e instanceof ToolError ? e.reason : e instanceof Error ? e.message : String(e));
      setPhase("done");
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-2 py-2" data-testid="edit-pane">
      <PaneHeader>Edit &amp; recompile - fn:{fn}</PaneHeader>

      <div className="px-3 text-xs text-text-muted" data-testid="recompile-attended-notice">
        Attended only: this produces a modified binary in a scratch copy, never the original bundle or the project. No
        worker may run it (spec 23 section 7); the server refuses one.
      </div>

      <div className="px-3">
        <textarea
          className={textareaClass}
          spellCheck={false}
          value={source}
          data-testid="recompile-source"
          placeholder={`// edited source for fn:${fn}, compiled with tools/hermesc for this bundle's version`}
          onChange={(e) => {
            setSource(e.target.value);
            if (phase !== "editing") reset();
          }}
        />
      </div>

      <div className="flex items-center gap-2 px-3">
        {phase === "confirming" ? (
          <>
            <ToolButton onClick={() => void run()} data-testid="recompile-confirm">
              Yes, recompile fn:{fn}
            </ToolButton>
            <ToolButton onClick={cancel} data-testid="recompile-cancel">
              Cancel
            </ToolButton>
            <span className="text-xs text-sev-med">This produces a modified binary. Confirm to continue.</span>
          </>
        ) : (
          <>
            <ToolButton
              onClick={() => {
                if (source.trim() === "") return setStatus("nothing to recompile - type the edited source first");
                setPhase("confirming");
              }}
              data-testid="recompile-run"
            >
              Recompile...
            </ToolButton>
            <ToolButton onClick={cancel} data-testid="recompile-cancel">
              Cancel
            </ToolButton>
            {phase === "running" && <span className="text-xs text-text-muted">compiling...</span>}
          </>
        )}
      </div>

      {error !== null && (
        <div className="px-3">
          <pre className={`${verbatimClass} text-sev-high`} data-testid="recompile-error">
            {error}
          </pre>
        </div>
      )}

      {result !== null && (
        <div className="flex flex-col gap-2">
          <div className="px-3">
            <pre className={`${verbatimClass} text-sev-med`} data-testid="recompile-warning">
              {result.warning}
            </pre>
          </div>
          <div className="px-3">
            <pre className={`${verbatimClass} text-text`} data-testid="recompile-watermark">
              {JSON.stringify(result.watermark, null, 2)}
            </pre>
          </div>
          <div data-testid="recompile-sandbox">
            <KeyVal k="sandbox" v={`${result.sandbox.id} (${result.sandbox.kind})`} />
            <KeyVal k="torn down" v={result.sandbox.tornDown ? "yes" : `NO - ${result.sandbox.teardownError ?? "unknown"}`} />
            <KeyVal k="output" v={result.outputPath} />
            <KeyVal k="logged as" v={result.rid} />
          </div>
        </div>
      )}
    </div>
  );
}
