// ui/src/panes/StringsPane.tsx — spec 22 §3's "xref panels … strings/globals":
// type a substring/regex, see matching strings with use counts, expand one
// to see the functions that use it, jump to a use. A second, smaller
// section does the same for a JS global by name (`GET /api/xref/global`).
// Lives as a tab in the right pane (`ui/src/panes/RightPane.tsx`), next to
// Xrefs — see docs/UI.md, "Strings & globals (xref)", for why the bottom
// pane (activity/log only) was the wrong home.
import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Empty } from "../components/primitives.tsx";
import {
  useDebouncedValue, useGlobalUses, useStringGrep, useStringUses, type FunctionCatalogue,
} from "../hooks.ts";
import type { StringGrepRow, StringUseSite, GlobalUse } from "../contracts.ts";
import { select } from "../state/selection.ts";
import { useStringsPrefill } from "./strings-store.ts";

const DEBOUNCE_MS = 250;

const inputClass =
  "h-7 w-full rounded-ui border border-border bg-surface-2 px-2 text-xs text-text outline-none placeholder:text-text-muted focus-visible:border-accent";
const modeBtn = (active: boolean): string =>
  `h-7 shrink-0 rounded-ui border px-2 text-xs ${active ? "border-accent bg-surface-2 text-text" : "border-border text-text-muted"}`;
const rowClass = "flex w-full items-center gap-2 px-3 py-0.5 text-left font-mono text-xs text-text hover:bg-surface-2";

/** Best-effort `fn -> name` lookup off the already-fetched function
 *  catalogue (`["functions-all"]`, `useFunctionCatalogue` in hooks.ts) —
 *  `xref/string`/`xref/global` rows carry only `fn` (see the API gap note
 *  in docs/UI.md), so this is a client-side join, not the server's. It may
 *  miss a function the tree has not paged in yet; the fallback is the bare
 *  `fn:<n>` label every other xref surface in the shell already uses. */
function useFnName(): (fn: number) => string {
  const qc = useQueryClient();
  return (fn: number): string => {
    const row = qc.getQueryData<FunctionCatalogue>(["functions-all"])?.rows.find((r) => r.fn === fn);
    return row?.name ?? `fn:${fn}`;
  };
}

function UseRow({ fn, detail, nameFor }: { readonly fn: number; readonly detail: string; readonly nameFor: (fn: number) => string }): ReactNode {
  return (
    <button type="button" data-fn={fn} onClick={() => select({ kind: "fn", fn })} className={rowClass} title={`jump to fn:${fn}`}>
      <span className="truncate">{nameFor(fn)}</span>
      <span className="ml-auto shrink-0 text-text-muted">{detail}</span>
    </button>
  );
}

function BoundedLine({ total, shown, truncated }: { readonly total: number; readonly shown: number; readonly truncated: boolean }): ReactNode {
  return (
    <div className="px-3 pb-1 text-xs text-text-muted">
      {shown} of {total} {total === 1 ? "row" : "rows"}
      {truncated && " (truncated)"}
    </div>
  );
}

function StringHit({
  row, expanded, onToggle, nameFor,
}: { readonly row: StringGrepRow; readonly expanded: boolean; readonly onToggle: () => void; readonly nameFor: (fn: number) => string }): ReactNode {
  const uses = useStringUses(expanded ? row.sid : undefined);
  return (
    <div className="border-b border-border">
      <button type="button" data-sid={row.sid} onClick={onToggle} className={rowClass} title={`sid:${row.sid}`}>
        <span className="shrink-0 text-text-muted">{row.sid}</span>
        <span className="truncate">{row.head}</span>
        <span className="ml-auto shrink-0 text-text-muted">{row.uses} use{row.uses === 1 ? "" : "s"}</span>
      </button>
      {expanded && (
        <div className="bg-surface-2/40 pb-1">
          {uses.data === undefined ? (
            <Empty>loading…</Empty>
          ) : uses.data.uses.rows.length === 0 ? (
            <Empty>no recorded uses</Empty>
          ) : (
            <>
              {uses.data.uses.rows.map((u: StringUseSite) => (
                <UseRow key={`${u.sid}-${u.fn}-${u.role}`} fn={u.fn} detail={`${u.role} x${u.n}`} nameFor={nameFor} />
              ))}
              <BoundedLine total={uses.data.uses.total} shown={uses.data.uses.rows.length} truncated={uses.data.uses.truncated} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function StringsSearch({ nameFor }: { readonly nameFor: (fn: number) => string }): ReactNode {
  const prefill = useStringsPrefill();
  const [mode, setMode] = useState<"substring" | "regex">("substring");
  const [pattern, setPattern] = useState("");
  const [expandedSid, setExpandedSid] = useState<number | undefined>(undefined);
  // A jump into this tab from a clicked string literal (`navigate.strings`)
  // pre-fills the search — every `seq` bump re-applies it, even for the
  // same string clicked twice in a row.
  useEffect(() => {
    if (prefill.text !== "") setPattern(prefill.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill.seq]);
  const debounced = useDebouncedValue(pattern, DEBOUNCE_MS);
  const grep = useStringGrep(mode, debounced);

  return (
    <div>
      <div className="flex items-center gap-1 border-b border-border px-2 py-2">
        <input
          type="search"
          value={pattern}
          placeholder="Search strings (substring or regex)"
          aria-label="search strings"
          data-testid="search-strings"
          onChange={(e) => setPattern(e.target.value)}
          className={inputClass}
        />
        <button type="button" className={modeBtn(mode === "substring")} onClick={() => setMode("substring")}>substring</button>
        <button type="button" className={modeBtn(mode === "regex")} onClick={() => setMode("regex")}>regex</button>
      </div>
      {debounced === "" ? (
        <Empty>type to search the string table</Empty>
      ) : grep.data === undefined ? (
        <Empty>loading…</Empty>
      ) : grep.data.rows.length === 0 ? (
        <Empty>no strings match "{debounced}"</Empty>
      ) : (
        <>
          <BoundedLine total={grep.data.total} shown={grep.data.rows.length} truncated={grep.data.truncated} />
          {grep.data.rows.map((row) => (
            <StringHit
              key={row.sid}
              row={row}
              expanded={expandedSid === row.sid}
              onToggle={() => setExpandedSid(expandedSid === row.sid ? undefined : row.sid)}
              nameFor={nameFor}
            />
          ))}
        </>
      )}
    </div>
  );
}

function GlobalsSearch({ nameFor }: { readonly nameFor: (fn: number) => string }): ReactNode {
  const [name, setName] = useState("");
  const debounced = useDebouncedValue(name, DEBOUNCE_MS);
  const uses = useGlobalUses(debounced);

  return (
    <div className="border-t border-border">
      <div className="px-3 pt-2 pb-1 text-xs text-text-muted">globals</div>
      <div className="px-2 pb-2">
        <input
          type="search"
          value={name}
          placeholder="Global name (e.g. console, __DEV__)"
          aria-label="search globals"
          data-testid="search-globals"
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
        />
      </div>
      {debounced === "" ? (
        <Empty>type a global's name</Empty>
      ) : uses.data === undefined ? (
        <Empty>loading…</Empty>
      ) : uses.data.rows.length === 0 ? (
        <Empty>no recorded uses of "{debounced}"</Empty>
      ) : (
        <>
          <BoundedLine total={uses.data.total} shown={uses.data.rows.length} truncated={uses.data.truncated} />
          {uses.data.rows.map((u: GlobalUse) => (
            <UseRow key={`${u.fn}-${u.access}`} fn={u.fn} detail={`${u.access} x${u.n}${u.file !== null ? ` · ${u.file}:${u.line ?? "?"}` : ""}`} nameFor={nameFor} />
          ))}
        </>
      )}
    </div>
  );
}

export function StringsPane(): ReactNode {
  const nameFor = useFnName();
  return (
    <div>
      <StringsSearch nameFor={nameFor} />
      <GlobalsSearch nameFor={nameFor} />
    </div>
  );
}
