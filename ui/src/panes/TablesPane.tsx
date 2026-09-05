// ui/src/panes/TablesPane.tsx — spec 17 §14.2's bundle-wide constant
// object-literal inventory ("endpoint tables"), surfaced as a **Tables**
// tab in the right pane (`ui/src/panes/RightPane.tsx`), next to Strings —
// same reasoning as docs/UI.md "Strings & globals (xref)": a query surface
// that jumps to a function belongs where the other query surfaces live, not
// in the bottom activity/log pane. Same shape as `StringsPane.tsx`: a
// filter bar over `GET /api/object-tables` (`useObjectTables`), a bounded,
// honestly-capped result list, one row expandable to its members, a member
// row that jumps to a function via the same `select()` call every other
// xref surface in the shell uses.
import { useEffect, useState, type ReactNode } from "react";
import { ResultTable } from "../components/ResultTable.tsx";
import { useDebouncedValue, useObjectTables } from "../hooks.ts";
import type { ObjectTablesQuery } from "../api.ts";
import type { ObjectTable, ObjectTableMember } from "../contracts.ts";
import { select } from "../state/selection.ts";
import { useTablesPrefill } from "./tables-store.ts";

const DEBOUNCE_MS = 250;
const MEMBERS_SHOWN_MAX = 40;
const PATHS_ONLY_PATTERN = "^(/|https?:)";

const inputClass =
  "h-7 w-full rounded-ui border border-border bg-surface-2 px-2 text-xs text-text outline-none placeholder:text-text-muted focus-visible:border-accent";
const numberInputClass = `${inputClass} w-20`;
const presetBtnClass = "h-7 shrink-0 rounded-ui border border-border px-2 text-xs text-text-muted hover:border-accent hover:text-text";

function parseNumber(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

function MemberRow({ member }: { readonly member: ObjectTableMember }): ReactNode {
  return (
    <div className="flex items-center gap-2 px-3 py-0.5 font-mono text-xs">
      <span className="shrink-0 text-text">{member.key}</span>
      <span className="text-text-muted">:</span>
      {member.kind === "string" ? (
        <span className="truncate text-text">{member.value}</span>
      ) : (
        <span className="truncate text-text-muted">{`<${member.kind}>`}</span>
      )}
    </div>
  );
}

/** The member list for one expanded table — a master/detail split, same
 *  reasoning as `StringsPane.tsx`'s `StringUsesDetail`: the table row
 *  itself stays a single fixed-height row so `ResultTable` can virtualise
 *  it, and the (up to `MEMBERS_SHOWN_MAX`) members live below it instead of
 *  growing the row in place. */
function TableMembersDetail({ table }: { readonly table: ObjectTable }): ReactNode {
  const shown = table.members.slice(0, MEMBERS_SHOWN_MAX);
  const hidden = table.members.length - shown.length;
  return (
    <div className="hbc-scroll h-32 min-h-0 shrink-0 overflow-auto border-t border-border bg-surface-2/40 py-1">
      {shown.map((m, i) => <MemberRow key={`${m.key}-${i}`} member={m} />)}
      {hidden > 0 && <div className="px-3 pt-1 text-xs text-text-muted">+{hidden} more</div>}
    </div>
  );
}

function tableSummary(table: ObjectTable): string {
  const base = `module ${table.module ?? "—"} · ${table.members.length} member${table.members.length === 1 ? "" : "s"} (${table.strings} string${table.strings === 1 ? "" : "s"})`;
  // `matched` == `members.length` whenever neither `key` nor `value` was
  // given (spec 17 §14.2's ranking follow-up); only worth showing once a
  // filter actually narrowed the hit, i.e. a FILTERED query — a bare member
  // count would otherwise be redundant with the count just printed.
  return table.matched !== table.members.length ? `${base} · ${table.matched} matched` : base;
}

export function TablesPane(): ReactNode {
  const prefill = useTablesPrefill();
  const [keyPattern, setKeyPattern] = useState("");
  const [valuePattern, setValuePattern] = useState("");
  const [minProps, setMinProps] = useState("");
  const [stringRatio, setStringRatio] = useState("");
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  // A jump into this tab from a clicked string literal (`navigate.tables`)
  // pre-fills the value filter — every `seq` bump re-applies it, even for
  // the same string clicked twice in a row (same as StringsPane's prefill).
  useEffect(() => {
    if (prefill.value !== "") setValuePattern(prefill.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill.seq]);

  const dKey = useDebouncedValue(keyPattern, DEBOUNCE_MS);
  const dValue = useDebouncedValue(valuePattern, DEBOUNCE_MS);
  const dMinProps = useDebouncedValue(minProps, DEBOUNCE_MS);
  const dStringRatio = useDebouncedValue(stringRatio, DEBOUNCE_MS);

  const minPropsN = parseNumber(dMinProps);
  const stringRatioN = parseNumber(dStringRatio);
  const query: ObjectTablesQuery = {
    ...(dKey !== "" ? { key: dKey } : {}),
    ...(dValue !== "" ? { value: dValue } : {}),
    ...(minPropsN !== undefined ? { minProps: minPropsN } : {}),
    ...(stringRatioN !== undefined ? { stringRatio: stringRatioN } : {}),
  };
  const tables = useObjectTables(query);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-2">
        <input
          type="search"
          value={keyPattern}
          placeholder="key regex"
          aria-label="tables key filter"
          data-testid="tables-key"
          onChange={(e) => setKeyPattern(e.target.value)}
          className={inputClass}
        />
        <input
          type="search"
          value={valuePattern}
          placeholder="value regex"
          aria-label="tables value filter"
          data-testid="tables-value"
          onChange={(e) => setValuePattern(e.target.value)}
          className={inputClass}
        />
        <input
          type="number"
          value={minProps}
          placeholder="min props"
          aria-label="tables min props"
          data-testid="tables-min-props"
          onChange={(e) => setMinProps(e.target.value)}
          className={numberInputClass}
        />
        <input
          type="number"
          value={stringRatio}
          placeholder="string ratio"
          aria-label="tables string ratio"
          data-testid="tables-string-ratio"
          min={0}
          max={1}
          step={0.1}
          onChange={(e) => setStringRatio(e.target.value)}
          className={numberInputClass}
        />
        <button
          type="button"
          className={presetBtnClass}
          title={`sets the value filter to ${PATHS_ONLY_PATTERN}`}
          onClick={() => setValuePattern(PATHS_ONLY_PATTERN)}
        >
          paths only
        </button>
      </div>
      <div className="h-64 min-h-0 shrink-0">
        <ResultTable
          data={tables.data?.tables ?? []}
          getRowId={(t) => `${t.fn}-${t.offset}`}
          rowElement="button"
          rowProps={(t) => ({ "data-fn": t.fn, "data-offset": t.offset, title: `fn:${t.fn} @0x${t.offset.toString(16)}` })}
          rowClassName={(t) => (expanded === `${t.fn}-${t.offset}` ? "border-l-2 border-l-accent bg-surface-2" : "")}
          onRowClick={(t) => {
            select({ kind: "fn", fn: t.fn });
            const key = `${t.fn}-${t.offset}`;
            setExpanded(expanded === key ? undefined : key);
          }}
          emptyMessage={tables.data === undefined ? "loading…" : "no constant tables match this filter"}
          cap={
            tables.data
              ? { shown: tables.data.tables.length, total: tables.data.total, truncated: tables.data.truncated, noun: "table" }
              : undefined
          }
          columns={[
            { id: "fn", header: "fn", accessorFn: (t: ObjectTable) => t.fn, cell: (info) => <span className="text-text-muted">{info.getValue() as number}</span> },
            { id: "name", header: "name", accessorFn: (t: ObjectTable) => t.fnName ?? "—", cell: (info) => <span>{info.getValue() as string}</span> },
            { id: "summary", header: "summary", accessorFn: tableSummary, cell: (info) => <span className="text-text-muted">{info.getValue() as string}</span> },
          ]}
        />
      </div>
      {tables.data !== undefined && expanded !== undefined && (() => {
        const t = tables.data.tables.find((x) => `${x.fn}-${x.offset}` === expanded);
        return t !== undefined ? <TableMembersDetail table={t} /> : null;
      })()}
      {tables.data !== undefined && (
        <div className="px-3 pt-1 text-xs text-text-muted">
          {tables.data.scanned} fn{tables.data.scanned === 1 ? "" : "s"} scanned{tables.data.failed > 0 && `, ${tables.data.failed} failed to decode`}
        </div>
      )}
    </div>
  );
}
