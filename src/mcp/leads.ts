// src/mcp/leads.ts — docs/specs/17-mcp-harness.md §14 additions 1 + 3: the
// lead-generation entry point (`leads`/`security-sinks`) and the paginated
// `search/functions` / `search/source` resources that replace the cut
// `query` (§14's "CUT `query` ... replaced by paginated `search/*`").
// Transport-agnostic, same discipline as resources.ts: pure functions over
// an already-open `ArtifactService`, deriving every answer from data the
// shipped index already carries (call-graph, native surface, string xrefs)
// — no new store, no network, no unbounded output.
import type { ArtifactService } from "../artifact/service.ts";

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
  return s.overlayName ?? s.name;
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

function paginate<T>(all: readonly T[], cursor: number): SearchPage<T> {
  const start = Math.max(0, cursor);
  const rows = all.slice(start, start + SEARCH_PAGE_CAP);
  const nextCursor = start + rows.length < all.length ? start + rows.length : null;
  return { rows, total: all.length, truncated: all.length > SEARCH_PAGE_CAP, nextCursor };
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
export function searchFunctions(artifact: ArtifactService, query: string, opts: { readonly regex?: boolean; readonly cursor?: number } = {}): SearchPage<FunctionMatch> {
  const re = opts.regex === true ? new RegExp(query, "i") : new RegExp(escapeRegex(query), "i");
  const all: FunctionMatch[] = [];
  let scanned = 0;
  for (const { fn, name } of artifact.listFns()) {
    if (scanned++ >= SEARCH_SCAN_CAP) break;
    if (name === null || !re.test(name)) continue;
    const summary = artifact.fn(fn);
    const size = summary.lines !== null ? summary.lines[1] - summary.lines[0] + 1 : null;
    all.push({ fn, name: summary.overlayName ?? name, size });
  }
  return paginate(all, opts.cursor ?? 0);
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
export function searchSource(artifact: ArtifactService, query: string, opts: { readonly regex?: boolean; readonly cursor?: number } = {}): SearchPage<SourceMatch> {
  const re = opts.regex === true ? new RegExp(query, "i") : new RegExp(escapeRegex(query), "i");
  const all: SourceMatch[] = [];
  let scanned = 0;
  for (const { fn, name } of artifact.listFns()) {
    if (scanned >= SEARCH_SCAN_CAP) break;
    const summary = artifact.fn(fn);
    if (summary.lines === null) continue;
    scanned++;
    let text: string;
    try {
      text = artifact.source(fn);
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const startLine = summary.lines[0];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (re.test(line)) {
        all.push({ fn, name: summary.overlayName ?? name, file: summary.file, line: startLine + i, text: line.length > SOURCE_MATCH_TEXT_CAP ? line.slice(0, SOURCE_MATCH_TEXT_CAP) : line });
      }
    }
  }
  return paginate(all, opts.cursor ?? 0);
}

export const LEADS_CAPS = { perClass: PER_CLASS_CAP, searchPage: SEARCH_PAGE_CAP, searchScan: SEARCH_SCAN_CAP } as const;
