// ui/src/state/log-delta.ts — spec 26 L1 (iii): a PURE mapping from one log
// entry (`ui/src/contracts.ts`'s `LogEntry`) to the TanStack Query key
// targets it invalidates, so an out-of-band write refreshes exactly the
// panes that changed instead of only reaching the Activity feed (spec 21
// §1.2/§1.3's whole point). `ui/src/hooks.ts`'s `useLog` calls `applyLogDelta`
// on every fresh row (SSE or poll — same code path, spec 21 §1.3) and turns
// each returned string into a `queryClient.invalidateQueries` call; this
// module knows nothing about React Query itself, so it is testable with
// plain `node --test`.
//
// A returned string is either a bare name ("findings") for a global key, or
// "<name>:<id>" for an id-scoped one (`hooks.ts` splits on the first ":" to
// recover the id) — `readonly string[]`, per spec 26 L1's own signature, not
// an array of TanStack `QueryKey` tuples, so this module stays framework-free.
//
// `detail` carries `{kind, target}` since this landing (`src/projdb/
// revision-store.ts`'s `appendLog`) — `target` is the `fn:N`/`mod:N`/`sid:N`
// binding-id vocabulary (`docs/` id.ts). A row minted before this landing, or
// one with no recognisable target (an `op:'init'` row, a malformed `detail`,
// an unknown target prefix), MUST invalidate nothing: guessing broad here
// would defeat the entire point of shard-addressed delta apply (a `mod:N`
// rename would otherwise have to blanket-refetch every fn pane "just in
// case").

/** The subset of `LogEntry` this module actually reads — kept structural
 *  (not imported from `../contracts.ts`) so a test fixture is a two-field
 *  object literal, not a full `LogEntry`. */
export interface LogDeltaEntry {
  readonly op: string;
  readonly detail: string | null;
}

interface ParsedDetail {
  readonly kind: string;
  readonly target: string;
}

function parseDetail(detail: string | null): ParsedDetail | undefined {
  if (detail === null || detail === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rec = parsed as Record<string, unknown>;
  const kind = rec.kind;
  const target = rec.target;
  if (typeof kind !== "string" || typeof target !== "string" || target === "") return undefined;
  return { kind, target };
}

const FN_TARGET = /^fn:(\d+)$/;
const MOD_TARGET = /^mod:(\d+)$/;

/** Which annotation kinds show up in the fn-scoped `["context", fn]` query
 *  (`ui/src/hooks.ts`'s `useContextResource`) — every kind the Context pane
 *  renders: name, comment, tag, bookmark, and a finding/status change
 *  (findings are listed per-fn there too). */
const CONTEXT_KINDS = new Set(["name", "comment", "tag", "bookmark", "finding", "status"]);

/** Maps one log entry to the query-key targets it invalidates. An entry
 *  whose target does not resolve (unparseable `detail`, or a target prefix
 *  this function does not recognise) invalidates NOTHING — never
 *  everything (spec 26 L1's own acceptance test). */
export function applyLogDelta(entry: LogDeltaEntry): readonly string[] {
  const parsed = parseDetail(entry.detail);
  if (parsed === undefined) return [];
  const { kind, target } = parsed;

  const fnMatch = FN_TARGET.exec(target);
  if (fnMatch !== null) {
    const fn = fnMatch[1];
    const out: string[] = [];
    if (CONTEXT_KINDS.has(kind)) out.push(`context:${fn}`);
    if (kind === "name") out.push(`fn:${fn}`, `who-calls-by-name:${fn}`);
    if (kind === "finding" || kind === "status") out.push("findings");
    return out;
  }

  const modMatch = MOD_TARGET.exec(target);
  if (modMatch !== null) {
    const mod = modMatch[1];
    const out: string[] = [`module:${mod}`];
    if (kind === "name") out.push(`package-id:${mod}`);
    return out;
  }

  // A target this function does not recognise (a `sid:N` string-table
  // binding, a bare tag slot, a future kind) — invalidate nothing rather
  // than guess. `hooks.ts`'s poll/SSE fallback still converges eventually
  // via its own periodic refetches of whichever query is actually mounted.
  return [];
}
