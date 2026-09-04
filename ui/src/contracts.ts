// ui/src/contracts.ts — the wire shapes the UI reads. Each interface MIRRORS
// a return type of `McpResources` in src/mcp/resources.ts (spec 17 §1/§14),
// which src/ui-server projects verbatim as JSON at `GET /api/...` (spec 19
// §3 Option A: "two transports over one warm service pair"). These are
// STRUCTURAL COPIES, not imports: ui/ is a separate package with its own
// tsconfig and must not reach into the root `src/` tree. If a shape here
// and its source in src/mcp/ ever disagree, src/mcp/ wins — fix this file.
//
// Source map (this file <- src/):
//   Bounded, FnSummary            <- src/artifact/service.ts
//   NeighborRef, XrefEdge         <- src/mcp/resources.ts
//   SinkLead, LeadGroup, LeadsResult, SearchPage, FunctionMatch,
//     SourceMatch, SinkClass      <- src/mcp/leads.ts
//   Provenance, EvidenceRef, FindingRecord, Severity, FindingStatus, Tag
//                                 <- src/project/schema.ts
//   ResolvedFinding               <- src/project/findings.ts

/** Every capped list resource: rows + the true total + whether it was cut. */
export interface Bounded<T> {
  readonly rows: readonly T[];
  readonly total: number;
  readonly truncated: boolean;
}

/** `fn/{fn}` — McpResources.fn(). */
export interface FnSummary {
  readonly fn: number;
  readonly name: string | null;
  readonly overlayName: string | null;
  readonly module: number | null;
  readonly file: string | null;
  readonly lines: readonly [number, number] | null;
  readonly params: number;
  readonly kind: string;
  readonly edgesIn: number;
  readonly edgesOut: number;
  readonly nativeSurfaceCount: number;
  readonly degraded: string | null;
}

/** `source/{fn}` and `disasm/{fn}` — both return this shape. */
export interface SourceText {
  readonly text: string;
  readonly totalLines: number;
  readonly truncated: boolean;
}

/** `GET /api/fn/{fn}/locals` — one nameable register of a function, with the
 *  identifier it currently renders as (the `reg:F:R` rename join). */
export interface LocalBinding {
  readonly reg: number;
  readonly rendered: string;
  readonly named: string | null;
  readonly role: string;
  readonly uses: number;
}

export interface LocalsListing {
  readonly rows: readonly LocalBinding[];
  readonly total: number;
}

/** Inlined `{fn,name,size}` neighbour metadata on every xref row (§14). */
export interface NeighborRef {
  readonly fn: number | string;
  readonly name: string | null;
  readonly size: number | null;
}

export interface XrefEdge extends NeighborRef {
  readonly file: string | null;
  readonly line: number | null;
  readonly kind: string;
  readonly why?: string;
}

export interface StringUse {
  readonly sid: number;
  readonly head: string;
  readonly role: string;
  readonly n: number;
}

/** `context/{fn}` — McpResources.context(); every member is optional
 *  because `include` selects which sections the server computed. */
export interface FnContext {
  readonly fn: number;
  readonly metadata?: FnSummary;
  readonly source?: SourceText;
  readonly callers?: Bounded<XrefEdge>;
  readonly callees?: Bounded<XrefEdge>;
  readonly strings?: Bounded<StringUse>;
}

/** `xref/who-calls/{fn}`. */
export type WhoCalls = Bounded<XrefEdge> & { readonly unknownInScope: number };

/** `xref/calls-from/{fn}`. */
export type CallsFrom = Bounded<XrefEdge>;

/** `module/{id}` — McpResources.module(). */
export interface ModuleInfo {
  readonly deps: readonly number[];
  readonly dependents: readonly number[];
  readonly ownedFnCount: number;
  readonly file: string | null;
}

/** `GET /api/module/{id}/source` — the WHOLE module file, with the line
 *  range of every function in it (1-based, inclusive, sorted by start).
 *  404 when the module has no file. This is the primary listing: an analyst
 *  reads a file, not a function (owner request, wave 2). */
export interface ModuleSourceFn {
  readonly fn: number;
  readonly name: string | null;
  readonly lines: readonly [number, number];
}

export interface ModuleSource {
  readonly module: number;
  readonly file: string;
  readonly text: string;
  readonly functions: readonly ModuleSourceFn[];
}

// -- leads / search ---------------------------------------------------------

export type SinkClass =
  | "verify" | "sign" | "decrypt" | "keychain" | "async-storage"
  | "webview" | "crypto" | "deep-link" | "eval";

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

/** `leads` and `security-sinks`. */
export interface LeadsResult {
  readonly groups: readonly LeadGroup[];
  readonly total: number;
  readonly truncated: boolean;
}

export interface SearchPage<T> {
  readonly rows: readonly T[];
  readonly total: number;
  readonly truncated: boolean;
  readonly nextCursor: number | null;
}

export interface FunctionMatch {
  readonly fn: number;
  readonly name: string | null;
  readonly size: number | null;
}

export interface SourceMatch {
  readonly fn: number;
  readonly name: string | null;
  readonly file: string | null;
  readonly line: number;
  readonly text: string;
}

// -- findings ---------------------------------------------------------------

export type Severity = "low" | "med" | "high" | "critical";
export type FindingStatus = "open" | "confirmed" | "refuted";
export type Tag =
  | "source" | "sink" | "sanitizer" | "reviewed" | "suspicious"
  | "provably-dead" | "attacker-reachable";

export interface Provenance {
  readonly source: "human" | "llm" | "tool";
  readonly who: string;
  readonly run?: string;
}

export interface EvidenceRef {
  readonly ref: string;
  readonly role: string;
  readonly span?: readonly [number, number];
  readonly patternId?: string;
  readonly useRole?: string;
  readonly n?: number;
  readonly note?: string;
}

export interface FindingRecord {
  readonly rid: string;
  readonly kind: "finding";
  readonly target: string;
  readonly prov: Provenance;
  readonly ts: string;
  readonly supersedes: string | null;
  readonly active: boolean;
  readonly claim: string;
  readonly severity: Severity;
  readonly evidence: readonly EvidenceRef[];
  readonly status: FindingStatus;
  readonly cwe?: string;
  readonly patternId?: string;
}

/** `findings[?tag&severity&status]` rows and `finding/{rid}`. */
export interface ResolvedFinding {
  readonly record: FindingRecord;
  readonly status: FindingStatus;
  readonly valid: boolean;
  readonly refs: readonly { readonly ref: EvidenceRef; readonly resolved: boolean }[];
}

// -- log --------------------------------------------------------------------

/** `log[?since&who]` row (spec 16 §3.2), newest first. The MVP live-update
 *  wire is polling this every second (spec 22 §1). */
export interface LogEntry {
  readonly seq: number;
  readonly ts: string;
  readonly who: string;
  readonly op: string;
  readonly detail: string | null;
}

export type LogPage = Bounded<LogEntry>;

/** `GET /api/log/tail?since=<seq>` (spec 22 §3.5): rows OLDEST-first with
 *  `seq > since`, plus the cursor to poll with next (the highest `seq`
 *  returned, or `since` unchanged when nothing was new). This — not
 *  `log`'s timestamp `since` — is the MVP live-update wire. */
export interface LogTail {
  readonly rows: readonly LogEntry[];
  readonly cursor: number;
}

// -- package identification -------------------------------------------------

/** `package-id/{mod}` — McpResources.packageId(): a two-key-gated
 *  identification (spec 13's identity + direct-version basis), or an
 *  honest refusal. Copied field-for-field from `PackageIdResult` in
 *  src/mcp/resources.ts; `identityBasis`/`versionBasis` are opaque strings
 *  to the UI, which only displays them. */
export type PackageIdResult =
  | { readonly available: false; readonly mod: number; readonly reason: string }
  | {
      readonly available: true;
      readonly mod: number;
      readonly package: string;
      readonly version: string | null;
      readonly tier: "claim" | "candidate";
      readonly identityBasis: string;
      readonly versionBasis: string;
      readonly evidence: string;
    };
