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
import { Empty } from "../components/primitives.tsx";
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
const rowClass = "flex w-full items-center gap-2 px-3 py-0.5 text-left font-mono text-xs text-text hover:bg-surface-2";

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

function TableRow({ table, expanded, onToggle }: { readonly table: ObjectTable; readonly expanded: boolean; readonly onToggle: () => void }): ReactNode {
  const shown = table.members.slice(0, MEMBERS_SHOWN_MAX);
  const hidden = table.members.length - shown.length;
  return (
    <div className="border-b border-border">
      <button
        type="button"
        data-fn={table.fn}
        data-offset={table.offset}
        onClick={() => {
          select({ kind: "fn", fn: table.fn });
          onToggle();
        }}
        className={rowClass}
        title={`fn:${table.fn} @0x${table.offset.toString(16)}`}
      >
        <span className="shrink-0 text-text-muted">fn</span>
        <span className="shrink-0">{table.fn}</span>
        <span className="truncate">{table.fnName ?? "—"}</span>
        <span className="ml-auto shrink-0 text-text-muted">
          module {table.module ?? "—"} · {table.members.length} member{table.members.length === 1 ? "" : "s"} ({table.strings} string{table.strings === 1 ? "" : "s"})
          {/* `matched` == `members.length` whenever neither `key` nor `value`
              was given (spec 17 §14.2's ranking follow-up); only worth
              showing once a filter actually narrowed the hit, i.e. a
              FILTERED query — a bare member count would otherwise be
              redundant with the count just printed. */}
          {table.matched !== table.members.length && ` · ${table.matched} matched`}
        </span>
      </button>
      {expanded && (
        <div className="bg-surface-2/40 pb-1">
          {shown.map((m, i) => <MemberRow key={`${m.key}-${i}`} member={m} />)}
          {hidden > 0 && <div className="px-3 pt-1 text-xs text-text-muted">+{hidden} more</div>}
        </div>
      )}
    </div>
  );
}

function BoundedLine({ total, shown, truncated, scanned, failed }: {
  readonly total: number; readonly shown: number; readonly truncated: boolean; readonly scanned: number; readonly failed: number;
}): ReactNode {
  return (
    <div className="px-3 pb-1 text-xs text-text-muted">
      {shown} of {total} {total === 1 ? "table" : "tables"}
      {truncated && " (truncated)"}
      {" · "}{scanned} fn{scanned === 1 ? "" : "s"} scanned{failed > 0 && `, ${failed} failed to decode`}
    </div>
  );
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
      {tables.data === undefined ? (
        <Empty>loading…</Empty>
      ) : tables.data.tables.length === 0 ? (
        <Empty>no constant tables match this filter</Empty>
      ) : (
        <>
          <BoundedLine
            total={tables.data.total}
            shown={tables.data.tables.length}
            truncated={tables.data.truncated}
            scanned={tables.data.scanned}
            failed={tables.data.failed}
          />
          {tables.data.tables.map((t) => {
            const key = `${t.fn}-${t.offset}`;
            return (
              <TableRow
                key={key}
                table={t}
                expanded={expanded === key}
                onToggle={() => setExpanded(expanded === key ? undefined : key)}
              />
            );
          })}
        </>
      )}
    </div>
  );
}
