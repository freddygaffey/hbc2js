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
  /** The ACCEPTED `fn:N` rename (`McpResources.withAnnotatedNames`), absent
   *  when the function was never renamed or the project is JSONL-backed.
   *  It outranks `overlayName`/`name` everywhere a function is named —
   *  `ui/src/listing/names.ts`'s `displayName` is the one place that
   *  decides, and the server applies the same name to the rendered source. */
  readonly acceptedName?: string;
  readonly module: number | null;
  readonly file: string | null;
  readonly lines: readonly [number, number] | null;
  readonly params: number;
  readonly kind: string;
  readonly edgesIn: number;
  readonly edgesOut: number;
  readonly nativeSurfaceCount: number;
  readonly degraded: string | null;
  /** Byte offset of the function header in the `.hbc` file — the real
   *  disasm offset `view.copyDisasmOffset` copies (`fn:<n>@0x<hex>`,
   *  `formatDisasmOffset` in `@ui-core/disasm-offset.ts`). */
  readonly offset: number;
}

/** `source/{fn}` and `disasm/{fn}` — both return this shape. */
/** One row of `GET /api/fn/{fn}/linemap` (docs/specs/05-emitter.md §16):
 *  `[line, fn, start, end]` — a 1-based line of the served source text, and
 *  the instruction behind it as a Hermes function index plus a half-open byte
 *  range within THAT function (`start` is what the disassembly prints as
 *  `[@ start]`). `fn` is usually the function being rendered but not always:
 *  a nested closure printed inside its parent contributes rows of its own. */
export type LineMapEntry = readonly [line: number, fn: number, start: number, end: number];

/** `GET /api/fn/{fn}/linemap` — the honest-partial source<->disasm map.
 *  `lines` is sorted by `line` and holds at most one row per line; it is empty,
 *  never an error, when the server cannot render the function.
 *  `fnStartLine` is the function text's first line in the module file. */
export interface LineMap {
  readonly fn: number;
  readonly fnStartLine: number | null;
  readonly lines: readonly LineMapEntry[];
}

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
  /** Spec 17 §14.4 (`require(N)` points-to pass): present ONLY on a resolved
   *  dynamic-dispatch edge; `exportName`/`module` are the module export the
   *  call went through. No UI pane reads these yet. */
  readonly confidence?: "points-to";
  readonly exportName?: string;
  readonly module?: number;
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

/** One row of `GET /api/xref/who-calls-by-name?fn=` (spec 17 §14.1): a
 *  function that reads property `name` — a NAME match on a `property-get`,
 *  NEVER a resolved call edge (`confidence` is always `"by-name"`; the
 *  server does not emit any other value). `name` here is the EXPORT name
 *  matched, not the caller's own name — that is `callerName` (the inlined
 *  `NeighborRef`, same as every other xref row). */
export interface ByNameCaller {
  readonly fn: number;
  readonly callerName: string | null;
  readonly size: number | null;
  readonly name: string;
  readonly role: string;
  readonly n: number;
  readonly file: string | null;
  readonly line: number | null;
  readonly confidence: "by-name";
}

/** One export name `who-calls-by-name` considered. A name the server judges
 *  too common to be a useful dispatch signal (`default`, `map`, … or over
 *  the fan-out limit) is `ambiguous: true` with a `why`, and contributes NO
 *  rows — the caller must show that explanation instead of an empty list. */
export interface ByNameEntry {
  readonly name: string;
  readonly sid: number | null;
  readonly ambiguous: boolean;
  readonly why?: string;
}

/** `GET /api/xref/who-calls-by-name?fn=N`. `excludedModule` is the
 *  exporting module the scan excluded from candidates (fn form only). */
export type WhoCallsByName = Bounded<ByNameCaller> & {
  readonly names: readonly ByNameEntry[];
  readonly excludedModule: number | null;
};

/** One member of a constant object table (`GET /api/object-tables`, spec 17
 *  §14.2). `value` is the constant string, truncated by the server; it is
 *  `null` for every non-string kind, including `computed` — a member the
 *  bytecode builds at runtime (`BASE + "/x"`), where only the KEY is known. */
export interface ObjectTableMember {
  readonly key: string;
  readonly value: string | null;
  readonly kind: "string" | "number" | "boolean" | "null" | "undefined" | "computed" | "unknown";
}

/** One constant object literal found bundle-wide. `numProps` counts the
 *  literal-buffer members only, so `members.length - numProps` is the
 *  computed tail. `fn`/`offset` locate the `NewObjectWithBuffer*`. */
export interface ObjectTable {
  readonly fn: number;
  readonly fnName: string | null;
  readonly size: number | null;
  readonly offset: number;
  readonly module: number | null;
  readonly numProps: number;
  readonly members: readonly ObjectTableMember[];
  readonly strings: number;
  readonly nonStrings: number;
  readonly computed: number;
  /** Members that satisfied the query's `key`/`value` patterns — the table's
   *  own member count when neither was given. A FILTERED query ranks on this
   *  (then on `matched / members.length`, then size), so a giant table with
   *  one accidental hit no longer outranks a real endpoint table. */
  readonly matched: number;
}

/** `GET /api/object-tables?minProps=&stringRatio=&key=&value=&module=&minMatched=&limit=`
 *  — the "endpoint tables" inventory. `scanned`/`failed` are the functions
 *  the one-pass bytecode scan decoded / could not decode. */
export interface ObjectTables {
  readonly tables: readonly ObjectTable[];
  readonly total: number;
  readonly truncated: boolean;
  readonly scanned: number;
  readonly failed: number;
}

/** One WebView-injection anti-pattern site (`GET /api/template-injections`,
 *  spec 17 §14.3, hunt lead C1): a template literal / `+` chain whose static
 *  text quotes a substitution, e.g. `` `window.foo('${userValue}')` `` or
 *  `"x = '" + userValue + "'"`. `prefix`/`suffix` are the static text either
 *  side of the reported quote pair, capped at ~120 chars; holes inside them
 *  are rendered as `${…}`. `substitutions` is how many of this call/chain's
 *  substitutions fall INSIDE the reported quotes (the ranking key);
 *  `nSubs` is the total in the whole template/chain. No UI pane yet —
 *  contracts only. */
export interface TemplateInjectionRow {
  readonly fn: number;
  readonly fnName: string | null;
  readonly size: number | null;
  readonly offset: number;
  readonly module: number | null;
  readonly kind: "template" | "concat";
  readonly quote: "'" | '"';
  readonly prefix: string;
  readonly suffix: string;
  readonly substitutions: number;
  readonly nSubs: number;
}

/** `GET /api/template-injections?module=&limit=` — bundle-wide scan result.
 *  `scanned`/`failed` are the functions the one-pass bytecode scan decoded /
 *  could not decode. */
export interface TemplateInjections {
  readonly rows: readonly TemplateInjectionRow[];
  readonly total: number;
  readonly truncated: boolean;
  readonly scanned: number;
  readonly failed: number;
}

/** A `strings.json` entry, verbatim (`src/artifact/schema.ts`'s
 *  `StringRow`) — either the literal value or, for a string over 4 KB, a
 *  head + hash instead of a silent truncation (§2.3a). */
export type StringValue =
  | { readonly sid: number; readonly v: string }
  | { readonly sid: number; readonly len: number; readonly sha256: string; readonly head: string };

/** One row of `xref/string`'s mode=exact `uses` (`string-uses.jsonl`), now
 *  inlined with the using function's `name`/`size` (`NeighborRef`) the same
 *  way `XrefEdge` is — see docs/UI.md, "Strings & globals (xref)". No
 *  file/line: a string use is not a call site with its own position. */
export interface StringUseSite {
  readonly sid: number;
  readonly fn: number;
  readonly role: string;
  readonly n: number;
  readonly name: string | null;
  readonly size: number | null;
}

/** `GET /api/xref/string?mode=exact&key=<sid>`. */
export interface StringExact {
  readonly value: StringValue | undefined;
  readonly uses: Bounded<StringUseSite>;
}

/** One row of `GET /api/xref/string?mode=substring|regex&key=`. */
export interface StringGrepRow {
  readonly sid: number;
  readonly head: string;
  readonly uses: number;
}

export type StringGrep = Bounded<StringGrepRow>;

/** One row of `GET /api/xref/global?name=`, inlined with the using
 *  function's `name`/`size` like `StringUseSite`. `file`/`line` are the
 *  OWNING FUNCTION's range, not a per-site position. */
export interface GlobalUse {
  readonly fn: number;
  readonly access: string;
  readonly n: number;
  readonly file: string | null;
  readonly line: number | null;
  readonly name: string | null;
  readonly size: number | null;
}

export type GlobalUses = Bounded<GlobalUse>;

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

/** `leads` and `security-sinks`. `computing` (spec 26 L6, docs/UI-BURS.md
 *  bur 1 row 2): `true` while the off-main-thread scan (`src/workers/
 *  leads-worker.ts`) has not settled yet — `groups`/`total` are the empty
 *  placeholder shape until then, exactly like `SegregationResult.computing`. */
export interface LeadsResult {
  readonly groups: readonly LeadGroup[];
  readonly total: number;
  readonly truncated: boolean;
  readonly computing?: boolean;
}

export interface SearchPage<T> {
  readonly rows: readonly T[];
  readonly total: number;
  readonly truncated: boolean;
  readonly nextCursor: number | null;
  /** Set only when an explicit `?limit=` cut the scan short (`src/mcp/leads.ts`
   *  `SearchOptions`/`paginate`) — `total` is then a LOWER BOUND, not the
   *  exact match count. Absent (never `false`) on a complete scan. */
  readonly partial?: true;
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

/** `history/{target}` row (spec 16 §3.2), newest first as the server sends
 *  it — `HistoryPane` (spec 26 L6) reverses it to render oldest-first. */
export interface HistoryEntry {
  readonly rid: number;
  readonly kind: string;
  readonly ts: string;
  readonly supersedes: number | null;
  readonly reactivates: number | null;
  readonly cleared: boolean;
  readonly who: string;
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
  /** ADDITIVE (spec 26 L1, spec 21 §1.3): the `fn:N`/`mod:N` ids this
   *  batch's rows name, deduped. A coarse doorbell-level hint only — the
   *  precise per-row invalidation is `ui/src/state/log-delta.ts`'s
   *  `applyLogDelta`, which `ui/src/hooks.ts`'s `useLog` actually calls; an
   *  old client that does not know this field is unaffected. */
  readonly targets?: readonly string[];
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

/** `GET /api/screens` (docs/specs/26-ui-full-ide.md L4) — the hierarchical
 *  screens tree with its navigation edges. The shapes are declared next to
 *  the pure model that consumes them (`./listing/screens.ts`, which the gate
 *  imports without a browser) and re-exported here so the contract surface
 *  stays one file. */
export type { NavConfidence, ScreenKind, ScreenNavEdge, ScreenRow, ScreensPage } from "./listing/screens.ts";

/** `GET /api/fn/{fn}/cfg` (docs/specs/26-ui-full-ide.md L9) — the read-only
 *  per-function block graph spec 25 §3 mode 3 draws. A STRUCTURAL copy of
 *  `src/ui-server/cfg.ts`'s own result types (contracts.ts's rule: the
 *  server wins any tie). The UI adds no CFG logic: it draws these rows. */
export interface CfgBlock {
  readonly id: number;
  /** Function-relative byte offsets, `[start, end)`. Both `-1` when the
   *  block is spec 03 §4.5's synthetic one (`synthetic`). */
  readonly start: number;
  readonly end: number;
  readonly instructions: number;
  readonly terminator: string;
  readonly isHandlerEntry: boolean;
  readonly entry: boolean;
  readonly exit: boolean;
  readonly synthetic: boolean;
  /** 1-based `[first, last]` inside the FUNCTION's own text, `null` when the
   *  render mapped no line into the block. */
  readonly lines: readonly [number, number] | null;
  /** The same span in module-file lines, `null` when unknown. */
  readonly fileLines: readonly [number, number] | null;
}

export type CfgEdgeKind =
  | "fallthrough" | "jump" | "branch-taken" | "branch-not-taken"
  | "switch-case" | "switch-default" | "exception";

export interface CfgEdge {
  readonly from: number;
  readonly to: number;
  readonly kind: CfgEdgeKind;
  readonly caseValue?: number;
  readonly caseIsString?: boolean;
}

export interface CfgRegion {
  readonly index: number;
  readonly startPc: number;
  readonly endPc: number;
  readonly handlerBlock: number;
  readonly catchRegister: number;
  readonly parent: number | null;
  readonly blocks: readonly number[];
}

export interface FnCfg {
  readonly fn: number;
  readonly entry: number;
  readonly fnStartLine: number | null;
  readonly blocks: readonly CfgBlock[];
  readonly edges: readonly CfgEdge[];
  readonly regions: readonly CfgRegion[];
  readonly total: number;
  readonly shown: number;
  readonly hidden: number;
  readonly truncated: boolean;
  readonly cap: number;
}

// -- spec 27 §L5: native-side (APK) read verbs -------------------------

export type SeamStatus = "linked" | "js-only" | "native-only";

/** The seam half of `GET /api/native/impl/:fn` — a narrow projection of the
 *  server's `native/seams.jsonl` row (docs/specs/10-artifact-format.md
 *  §2.8), just what the Context-pane row shows. */
export interface NativeImplSeam {
  readonly key: string;
  readonly jsName: string | null;
  readonly jsMethod: string | null;
  readonly status: SeamStatus;
  readonly firstParty: boolean | null;
}

/** The native-module half, `null` on a `js-only` seam. */
export interface NativeImplModule {
  readonly key: string;
  readonly jsName: string | null;
  readonly kind: string;
  readonly firstParty: boolean | null;
}

export interface NativeImplRow {
  readonly seam: NativeImplSeam;
  readonly module: NativeImplModule | null;
}

/** `GET /api/native/impl/:fn` — every seam whose JS evidence cites `fn` as a
 *  call site (spec 27 §L5's Context-pane "native impl" row). Empty when
 *  this fn participates in no seam or the project has no native side. */
export interface NativeImpl {
  readonly fn: number;
  readonly rows: readonly NativeImplRow[];
}
