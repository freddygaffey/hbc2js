// ui/src/panes/StringsPane.tsx — spec 22 §3's "xref panels … strings/globals":
// type a substring/regex, see matching strings with use counts, expand one
// to see the functions that use it, jump to a use. A second, smaller
// section does the same for a JS global by name (`GET /api/xref/global`).
// Lives as a tab in the right pane (`ui/src/panes/RightPane.tsx`), next to
// Xrefs — see docs/UI.md, "Strings & globals (xref)", for why the bottom
// pane (activity/log only) was the wrong home.
import { useEffect, useState, type ReactNode } from "react";
import { Empty } from "../components/primitives.tsx";
import { ResultTable } from "../components/ResultTable.tsx";
import { useDebouncedValue, useGlobalUses, useStringGrep, useStringUses } from "../hooks.ts";
import type { StringGrepRow, StringUseSite, GlobalUse } from "../contracts.ts";
import { select } from "../state/selection.ts";
import { useStringsPrefill } from "./strings-store.ts";

const DEBOUNCE_MS = 250;

const inputClass =
  "h-7 w-full rounded-ui border border-border bg-surface-2 px-2 text-xs text-text outline-none placeholder:text-text-muted focus-visible:border-accent";
const modeBtn = (active: boolean): string =>
  `h-7 shrink-0 rounded-ui border px-2 text-xs ${active ? "border-accent bg-surface-2 text-text" : "border-border text-text-muted"}`;
const rowClass = "flex w-full items-center gap-2 px-3 py-0.5 text-left font-mono text-xs text-text hover:bg-surface-2";

/** `xref/string`'s `exact` uses and `xref/global`'s rows are now inlined
 *  server-side with the using function's name (`McpResources.neighbor()`,
 *  same as `who-calls`/`calls-from`) — prefer that; `fn:<n>` is the last
 *  resort for a row the server cannot name (native/unknown neighbour), same
 *  as every other xref surface in the shell. No client-side catalogue join
 *  needed any more (see docs/UI.md, "Strings & globals (xref)"). */
function UseRow({ fn, name, detail }: { readonly fn: number; readonly name: string | null; readonly detail: string }): ReactNode {
  return (
    <button type="button" data-fn={fn} onClick={() => select({ kind: "fn", fn })} className={rowClass} title={`jump to fn:${fn}`}>
      <span className="truncate">{name ?? `fn:${fn}`}</span>
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

/** The detail panel for one expanded string hit — a master/detail split
 *  (the table row itself stays a single fixed-height row, so it can be
 *  virtualised; the uses list, which can be long, lives below the table
 *  instead of growing the row in place). */
function StringUsesDetail({ sid }: { readonly sid: number }): ReactNode {
  const uses = useStringUses(sid);
  return (
    <div className="h-32 min-h-0 shrink-0 border-t border-border bg-surface-2/40 py-1">
      {uses.data === undefined ? (
        <Empty>loading…</Empty>
      ) : uses.data.uses.rows.length === 0 ? (
        <Empty>no recorded uses</Empty>
      ) : (
        <>
          {uses.data.uses.rows.map((u: StringUseSite) => (
            <UseRow key={`${u.sid}-${u.fn}-${u.role}`} fn={u.fn} name={u.name} detail={`${u.role} x${u.n}`} />
          ))}
          <BoundedLine total={uses.data.uses.total} shown={uses.data.uses.rows.length} truncated={uses.data.uses.truncated} />
        </>
      )}
    </div>
  );
}

function StringsSearch(): ReactNode {
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
      ) : (
        <>
          <div className="h-40 min-h-0 shrink-0">
            <ResultTable
              data={grep.data?.rows ?? []}
              getRowId={(row) => String(row.sid)}
              rowElement="button"
              rowProps={(row) => ({ "data-sid": row.sid, title: `sid:${row.sid}` })}
              rowClassName={(row) => (expandedSid === row.sid ? "border-l-2 border-l-accent bg-surface-2" : "")}
              onRowClick={(row) => setExpandedSid(expandedSid === row.sid ? undefined : row.sid)}
              emptyMessage={grep.data === undefined ? "loading…" : `no strings match "${debounced}"`}
              cap={grep.data ? { shown: grep.data.rows.length, total: grep.data.total, truncated: grep.data.truncated, noun: "string" } : undefined}
              columns={[
                { id: "sid", header: "sid", accessorFn: (row: StringGrepRow) => row.sid, cell: (info) => <span className="text-text-muted">{info.getValue() as number}</span> },
                { id: "head", header: "text", accessorFn: (row: StringGrepRow) => row.head, cell: (info) => <span>{info.getValue() as string}</span> },
                { id: "uses", header: "uses", accessorFn: (row: StringGrepRow) => row.uses, cell: (info) => <span className="text-text-muted">{info.getValue() as number}</span> },
              ]}
            />
          </div>
          {expandedSid !== undefined && <StringUsesDetail sid={expandedSid} />}
        </>
      )}
    </div>
  );
}

function GlobalsSearch(): ReactNode {
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
      ) : (
        <div className="h-40 min-h-0 shrink-0">
          <ResultTable
            data={uses.data?.rows ?? []}
            getRowId={(u) => `${u.fn}-${u.access}`}
            rowElement="button"
            rowProps={(u) => ({ "data-fn": u.fn })}
            onRowClick={(u) => select({ kind: "fn", fn: u.fn })}
            emptyMessage={uses.data === undefined ? "loading…" : `no recorded uses of "${debounced}"`}
            cap={uses.data ? { shown: uses.data.rows.length, total: uses.data.total, truncated: uses.data.truncated, noun: "use" } : undefined}
            columns={[
              { id: "name", header: "name", accessorFn: (u: GlobalUse) => u.name ?? `fn:${u.fn}`, cell: (info) => <span className="font-mono">{info.getValue() as string}</span> },
              {
                id: "detail",
                header: "detail",
                accessorFn: (u: GlobalUse) => `${u.access} x${u.n}${u.file !== null ? ` · ${u.file}:${u.line ?? "?"}` : ""}`,
                cell: (info) => <span className="text-text-muted">{info.getValue() as string}</span>,
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}

export function StringsPane(): ReactNode {
  return (
    <div>
      <StringsSearch />
      <GlobalsSearch />
    </div>
  );
}
