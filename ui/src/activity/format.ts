// ui/src/activity/format.ts — turns one raw `log` row (`op` + a JSON
// `detail` string) into a compact, human summary for the Activity tab.
//
// `detail`'s shape comes from the writer, not a contract this file can rely
// on structurally (`src/projdb/ix-write.ts`'s `init`/`rebuild-index` rows,
// `src/projdb/revision-store.ts`/`rebuild.ts`'s `annotate`/`revert` rows —
// see those files' `insertLog`/`appendLog` call sites). Everything here is
// therefore defensive: an unrecognised `op` or an unparsable `detail` falls
// back to showing the op name and the raw JSON rather than throwing.
import type { LogEntry } from "../contracts.ts";

/** Parses `detail` if present and an object; `null` on anything else
 *  (missing, not JSON, not an object) so callers can use plain property
 *  access without a `typeof` dance at every call site. */
export function parseDetail(detail: string | null): Record<string, unknown> | null {
  if (detail === null || detail === "") return null;
  try {
    const v: unknown = JSON.parse(detail);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `annotate`/`revert` rows carry `{"kind": <RevisionKind>}` (spec 16 §2.2's
 *  `revision_tier` kinds) — one verb per kind, read off the row's own `op`
 *  for revert vs. a fresh write. */
const ANNOTATE_VERBS: Record<string, string> = {
  name: "renamed",
  comment: "commented",
  tag: "tagged",
  bookmark: "bookmarked",
  finding: "finding recorded",
  status: "status changed",
  conflict: "conflict recorded",
};

function commaInt(n: unknown): string | null {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : null;
}

/** One line of prose for the Activity tab (the raw Log tab shows `op` +
 *  `detail` verbatim instead — this is the friendly view). */
export function summarize(entry: LogEntry): string {
  const detail = parseDetail(entry.detail);
  switch (entry.op) {
    case "init":
      return "project initialised";
    case "rebuild-index": {
      const n = commaInt(detail?.["functions"]);
      return n === null ? "project index rebuilt" : `project initialised: ${n} functions`;
    }
    case "annotate":
    case "revert": {
      const kind = typeof detail?.["kind"] === "string" ? (detail["kind"] as string) : null;
      const verb = kind !== null ? ANNOTATE_VERBS[kind] ?? `${kind} updated` : "updated";
      return entry.op === "revert" ? `reverted (${verb})` : verb;
    }
    default:
      return detail === null ? entry.op : `${entry.op}: ${JSON.stringify(detail)}`;
  }
}

/** `fn:<n>` target this row names, if any — so a click can `select({kind:
 *  "fn", fn})` (`ui/src/state/selection.ts`). Current server `detail`
 *  payloads (see the doc comment above) do not carry a target today; this
 *  reads `detail.target`/`detail.fn` defensively so a future server that
 *  adds one lights the row up for free rather than the UI needing a
 *  follow-up change. */
export function targetFn(entry: LogEntry): number | null {
  const detail = parseDetail(entry.detail);
  if (detail === null) return null;
  const target = detail["target"];
  if (typeof target === "string") {
    const m = /^fn:(\d+)$/.exec(target);
    if (m !== null) return Number(m[1]);
  }
  const fn = detail["fn"];
  if (typeof fn === "number" && Number.isInteger(fn)) return fn;
  return null;
}

/** `HH:MM:SS` in the viewer's local time zone. */
export function formatTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString("en-US", { hour12: false });
}
