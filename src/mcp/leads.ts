// src/mcp/leads.ts — docs/specs/17-mcp-harness.md §14 additions 1 + 3: the
// lead-generation entry point (`leads`/`security-sinks`) and the paginated
// `search/functions` / `search/source` resources that replace the cut
// `query` (§14's "CUT `query` ... replaced by paginated `search/*`").
// Transport-agnostic, same discipline as resources.ts: pure functions over
// an already-open `ArtifactService`, deriving every answer from data the
// shipped index already carries (call-graph, native surface, string xrefs)
// — no new store, no network, no unbounded output.
import { readFileSync } from "node:fs";
import type { ArtifactService } from "../artifact/service.ts";
import { drainAsync, drainSync, type Steps } from "../incremental.ts";

// -- leads / security-sinks ------------------------------------------------

/** The security-decision classes the hunt actually needed (spec 17 §14
 *  addition 1's own list). Not exhaustive — extend the pattern table below
 *  as new classes prove useful; the shape (native-name / string-content /
 *  global-read) covers most "who decided this was safe" call sites without
 *  a dataflow engine (§14's flagged future `trace`/`dataflow`). */
export type SinkClass = "verify" | "sign" | "decrypt" | "keychain" | "async-storage" | "webview" | "crypto" | "deep-link" | "eval";

/** One sink call site. `evidence` is a resolving evidence ref in the exact
 *  vocabulary `record_finding`/`ArtifactEvidenceResolver` already accept
 *  (`fn:N` / `sid:N`, spec 11 §4.1) — a lead can be handed straight to
 *  `record_finding` as its evidence without reformatting. `fn` is `null`
 *  only for a string-based hit with no recorded use site (the string
 *  itself is still real evidence via `sid:`, there is just no owning
 *  function to name). */
export interface SinkLead {
  readonly fn: number | null;
  readonly name: string | null;
  readonly class: SinkClass;
  readonly evidence: string;
  readonly detail: string;
}

export interface LeadGroup {
  readonly class: SinkClass;
  readonly leads: readonly SinkLead[];
  readonly total: number;
  readonly truncated: boolean;
}

export interface LeadsResult {
  readonly groups: readonly LeadGroup[];
  readonly total: number;
  readonly truncated: boolean;
  /** Set only by `src/ui-server/list.ts`'s off-main-thread wrapper
   *  (docs/UI-BURS.md bur 1 row 2) while a `node:worker_threads` compute is
   *  still in flight — `computeLeads` itself never sets this; the MCP
   *  `leads`/`security-sinks` resources always answer settled. */
  readonly computing?: boolean;
}

const PER_CLASS_CAP = 20;

interface ClassPattern {
  /** Tested against `native.jsonl`'s `NativeRow.name` (bridge-module /
   *  host-global names — e.g. `RNKeychainManager`, `RNCAsyncStorage`). */
  readonly native?: RegExp;
  /** Tested against every string constant's value/head (`stringGrep`). */
  readonly string?: RegExp;
  /** Global names to pull via `globalUses` (site-level read/write/call). */
  readonly global?: readonly string[];
}

// Curated from observation, not from hermes-dec (CLAUDE.md — derived from
// our own fixtures/native-module naming conventions, src/deps/native-
// modules.ts's curated map for the vocabulary).
const SINK_PATTERNS: Record<SinkClass, ClassPattern> = {
  keychain: { native: /keychain|securestorage|sensitiveinfo|biometric/i, string: /keychain|genericpassword|securestorage/i },
  "async-storage": { native: /asyncstorage/i, string: /asyncstorage/i },
  webview: { native: /webview|inappbrowser/i, string: /\bwebview\b/i },
  "deep-link": { native: /linking/i, string: /^[a-z][a-z0-9+.-]{1,15}:\/\/\S+/i },
  crypto: { native: /crypto|cipher/i, string: /\b(aes|rsa|hmac|sha-?1|sha-?256|pbkdf2|createcipher|createdecipher)\b/i },
  verify: { string: /verifysignature|isvalidsignature|\bverify\(/i },
  sign: { string: /\bsign\(|signature/i },
  decrypt: { string: /\bdecrypt/i },
  eval: { global: ["eval", "Function"] },
};

function nameOf(artifact: ArtifactService, fn: number): string | null {
  if (!artifact.hasFn(fn)) return null;
  const s = artifact.fn(fn);
  return artifact.acceptedFnName(fn) ?? s.overlayName ?? s.name;
}

/** `leads` / `security-sinks` — spec 17 §14 addition 1, the hunt's entry
 *  point: every security-decision call site the artifact already knows
 *  about, grouped by class. Each class independently capped
 *  (`PER_CLASS_CAP`); a class with zero hits is omitted rather than
 *  returned empty. */
export function computeLeads(artifact: ArtifactService): LeadsResult {
  const groups: LeadGroup[] = [];
  let total = 0;
  let truncated = false;

  for (const cls of Object.keys(SINK_PATTERNS) as SinkClass[]) {
    const pattern = SINK_PATTERNS[cls];
    const leads: SinkLead[] = [];

    if (pattern.native !== undefined) {
      for (const row of artifact.native({ all: true }).rows) {
        if (pattern.native.test(row.name)) {
          leads.push({ fn: row.fn, name: nameOf(artifact, row.fn), class: cls, evidence: `fn:${row.fn}`, detail: `native ${row.surface}: ${row.name}` });
        }
      }
    }
    if (pattern.string !== undefined) {
      for (const hit of artifact.stringGrep(pattern.string.source, { all: true }).rows) {
        const uses = artifact.string(hit.sid).uses.rows;
        if (uses.length === 0) {
          leads.push({ fn: null, name: null, class: cls, evidence: `sid:${hit.sid}`, detail: `string (no use site): ${hit.head}` });
          continue;
        }
        for (const u of uses) {
          leads.push({ fn: u.fn, name: nameOf(artifact, u.fn), class: cls, evidence: `sid:${hit.sid}`, detail: hit.head });
        }
      }
    }
    if (pattern.global !== undefined) {
      for (const g of pattern.global) {
        for (const row of artifact.globalUses(g, { all: true }).rows) {
          leads.push({ fn: row.fn, name: nameOf(artifact, row.fn), class: cls, evidence: `fn:${row.fn}`, detail: `global ${g} (${row.access})` });
        }
      }
    }

    const seen = new Set<string>();
    const deduped = leads.filter((l) => {
      const key = `${l.fn}:${l.evidence}:${l.detail}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (deduped.length === 0) continue;
    const groupTruncated = deduped.length > PER_CLASS_CAP;
    truncated = truncated || groupTruncated;
    total += deduped.length;
    groups.push({ class: cls, leads: deduped.slice(0, PER_CLASS_CAP), total: deduped.length, truncated: groupTruncated });
  }

  return { groups, total, truncated };
}

// -- search/functions + search/source --------------------------------------

/** A page of results: hard output cap (`SEARCH_PAGE_CAP`) plus a
 *  `nextCursor` for the caller to page through the rest — the typed,
 *  bounded replacement for the cut `query` (§14). */
export interface SearchPage<T> {
  readonly rows: readonly T[];
  readonly total: number;
  readonly truncated: boolean;
  readonly nextCursor: number | null;
  /** Set only when the scan STOPPED EARLY because the caller passed an
   *  explicit `limit` and the page was already full (`search/source`):
   *  `total` is then a lower bound on the number of matches, not the count.
   *  Absent (never `false`) on a complete scan, so an unbounded query's
   *  answer is byte-identical to what it always was. */
  readonly partial?: true;
}

/** Options every `search/*` resource takes. `limit` only ever NARROWS the
 *  page (clamped into `[1, SEARCH_PAGE_CAP]`) — it can never widen a cap —
 *  and, for `search/source`, it is pushed down into the scan itself: the
 *  walk stops as soon as the page plus one row (enough to know whether
 *  there is a next page) is filled, which is what makes a type-ahead query
 *  from the UI's string-search box cheap. */
export interface SearchOptions {
  readonly regex?: boolean;
  readonly cursor?: number;
  readonly limit?: number;
}

const SEARCH_PAGE_CAP = 50;
// A cost bound independent of the OUTPUT cap above: how many functions this
// call will walk before giving up, so an unanchored substring on a huge
// bundle can't turn one MCP call into a multi-second full-artifact scan.
// Distinct from `truncated` (which reports the OUTPUT was capped) — a scan
// cut short by this bound is reported via the same `truncated` flag, honest
// either way (the caller sees "there may be more", never a silent under-count).
const SEARCH_SCAN_CAP = 20_000;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A caller-supplied `?limit=` clamped into `[1, SEARCH_PAGE_CAP]`; absent
 *  or nonsense means the full page. Never widens the cap. */
function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return SEARCH_PAGE_CAP;
  return Math.min(Math.floor(limit), SEARCH_PAGE_CAP);
}

function paginate<T>(all: readonly T[], cursor: number, pageSize: number = SEARCH_PAGE_CAP, partial = false): SearchPage<T> {
  const start = Math.max(0, cursor);
  const rows = all.slice(start, start + pageSize);
  const nextCursor = start + rows.length < all.length ? start + rows.length : null;
  const page: SearchPage<T> = { rows, total: all.length, truncated: all.length > pageSize, nextCursor };
  return partial ? { ...page, partial: true } : page;
}

export interface FunctionMatch {
  readonly fn: number;
  readonly name: string | null;
  readonly size: number | null;
}

/** `search/functions` — name substring/regex match over every function in
 *  the artifact, paginated. The safe, typed replacement for the cut `query`
 *  (§14): "finding the licence-validity function" without dumping the
 *  whole function table. */
export function searchFunctions(artifact: ArtifactService, query: string, opts: SearchOptions = {}): SearchPage<FunctionMatch> {
  const re = opts.regex === true ? new RegExp(query, "i") : new RegExp(escapeRegex(query), "i");
  const all: FunctionMatch[] = [];
  let scanned = 0;
  for (const { fn, name } of artifact.listFns()) {
    if (scanned++ >= SEARCH_SCAN_CAP) break;
    // docs/BUGS.md "search/functions matches the bytecode name only": a
    // renamed function DISPLAYS its accepted `fn:N` name (below), so typing
    // that new name must find the row too, not just the pre-rename bytecode
    // name (which keeps matching too, deliberately — a search someone had
    // already relied on must not go dead the moment a function is renamed).
    // `acceptedFnName` is a memoised map lookup (`fnNameInfo()`, cheap per
    // scanned row) — unlike `overlayNameOf` below, which stays
    // matched-rows-only per its own docstring (a real per-fn index query).
    const accepted = artifact.acceptedFnName(fn);
    const matchesBytecodeName = name !== null && re.test(name);
    const matchesAcceptedName = accepted !== null && re.test(accepted);
    if (!matchesBytecodeName && !matchesAcceptedName) continue;
    const summary = artifact.fn(fn);
    const size = summary.lines !== null ? summary.lines[1] - summary.lines[0] + 1 : null;
    all.push({ fn, name: accepted ?? summary.overlayName ?? name, size });
  }
  return paginate(all, opts.cursor ?? 0, clampSearchLimit(opts.limit));
}

export interface SourceMatch {
  readonly fn: number;
  readonly name: string | null;
  readonly file: string | null;
  readonly line: number;
  readonly text: string;
}

const SOURCE_MATCH_TEXT_CAP = 200;

/** `search/source` — bounded grep over every function's own rendered
 *  source range, paginated. Skips functions with no recorded range (no
 *  `--split`/`init` output for them — native/unresolved, same cases
 *  `source`/`context` already skip). */
/** Module text read once per file for the duration of ONE scan. The old
 *  `search/source` called `artifact.source(fn)` per function, which
 *  `readFileSync`s and splits the WHOLE module file every time — 15,000
 *  functions over 4,510 modules re-read the same text dozens of times each.
 *  Bounded to {@link MODULE_TEXT_CACHE} files so a bundle-wide scan holds a
 *  handful of module files, never the whole rendered tree; functions are
 *  walked in `fn` order and a module owns a contiguous run of them, so the
 *  hit rate is ~1 read per module either way. Per-scan, never shared: a
 *  later scan re-reads, so a re-decompile or a write is never served stale. */
const MODULE_TEXT_CACHE = 64;

class ModuleTextCache {
  private readonly cache = new Map<string, readonly string[] | null>();
  private readonly artifact: ArtifactService;
  constructor(artifact: ArtifactService) {
    this.artifact = artifact;
  }
  lines(file: string): readonly string[] | null {
    const hit = this.cache.get(file);
    if (hit !== undefined) return hit;
    let value: readonly string[] | null;
    try {
      value = readFileSync(this.artifact.modulePath(file), "utf8").split("\n");
    } catch {
      value = null;
    }
    if (this.cache.size >= MODULE_TEXT_CACHE) {
      const oldest = this.cache.keys().next();
      if (oldest.done !== true) this.cache.delete(oldest.value);
    }
    this.cache.set(file, value);
    return value;
  }
}

/** `search/source` as steps (one `yield` per function scanned) — the single
 *  implementation behind both {@link searchSource} (drained straight
 *  through: MCP/CLI) and {@link searchSourceAsync} (drained yielding, so the
 *  ui-server keeps answering every other route while a search runs; see
 *  `src/incremental.ts` for why this is not a worker). */
export function* searchSourceSteps(artifact: ArtifactService, query: string, opts: SearchOptions = {}): Steps<SearchPage<SourceMatch>> {
  const re = opts.regex === true ? new RegExp(query, "i") : new RegExp(escapeRegex(query), "i");
  const cursor = Math.max(0, opts.cursor ?? 0);
  const pageSize = clampSearchLimit(opts.limit);
  // `limit` pushed down: with an explicit one, the scan stops as soon as it
  // holds the requested page plus one row (all it takes to know whether
  // there is a next page). Without one, the walk is exhaustive and `total`
  // stays the exact match count, as it always was.
  const stopAt = opts.limit !== undefined ? cursor + pageSize + 1 : Number.POSITIVE_INFINITY;
  const all: SourceMatch[] = [];
  const texts = new ModuleTextCache(artifact);
  let scanned = 0;
  let partial = false;
  for (const r of artifact.listRanges()) {
    if (scanned >= SEARCH_SCAN_CAP) {
      partial = true;
      break;
    }
    scanned++;
    yield;
    let lines: readonly string[];
    if (artifact.hasActiveNames(r.fn)) {
      // Renamed function: `source(fn)` re-renders it, so the disk text
      // below would match against pre-rename names. Rare (only functions
      // with accepted `reg:F:R` names), so the slow path is fine here.
      try {
        lines = artifact.source(r.fn).split("\n");
      } catch {
        continue;
      }
    } else {
      const fileLines = texts.lines(r.file);
      if (fileLines === null) continue;
      lines = fileLines.slice(r.lines[0] - 1, r.lines[1]);
    }
    const startLine = r.lines[0];
    let name: string | null | undefined;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!re.test(line)) continue;
      if (name === undefined) name = artifact.overlayNameOf(r.fn) ?? r.name;
      all.push({ fn: r.fn, name, file: r.file, line: startLine + i, text: line.length > SOURCE_MATCH_TEXT_CAP ? line.slice(0, SOURCE_MATCH_TEXT_CAP) : line });
    }
    if (all.length >= stopAt) {
      partial = true;
      break;
    }
  }
  return paginate(all, cursor, pageSize, partial);
}

/** `search/source` — bounded grep over every function's own rendered source
 *  range, paginated. Skips functions with no recorded range (no
 *  `--split`/`init` output for them — native/unresolved, same cases
 *  `source`/`context` already skip). */
export function searchSource(artifact: ArtifactService, query: string, opts: SearchOptions = {}): SearchPage<SourceMatch> {
  return drainSync(searchSourceSteps(artifact, query, opts));
}

/** {@link searchSource}'s answer, computed without holding the event loop:
 *  the ui-server route uses this one so a search never head-of-line-blocks
 *  the jobs rail, the code pane or anything else (docs/BUGS.md
 *  "search/source blocks the ui-server" row). */
export function searchSourceAsync(artifact: ArtifactService, query: string, opts: SearchOptions = {}): Promise<SearchPage<SourceMatch>> {
  return drainAsync(searchSourceSteps(artifact, query, opts));
}

export const LEADS_CAPS = { perClass: PER_CLASS_CAP, searchPage: SEARCH_PAGE_CAP, searchScan: SEARCH_SCAN_CAP } as const;
