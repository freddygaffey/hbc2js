// src/artifact/service.ts — the query surface (docs/specs/10-artifact-format.md
// §3). One resident class, `ArtifactService`, loads a built artifact
// directory once (manifest + every index file), verifies staleness at
// construction (§4.2), and serves every §3.1 verb as an already-bounded row
// set. `hbc2js query <verb>` (src/cli.ts) is a thin formatting wrapper over
// this class — the files ARE the contract (§3); this class exists so a
// resident loop (or the CLI) never re-parses JSONL per call.
//
// `list`/`context` (§3.1, P2.1a(b)) are the two LIVE verbs: they need the
// warm frame bodies the gate already computes from bytecode
// (`src/name-overlay/frames.ts`/`gate.ts`), not the on-disk index — so this
// class optionally takes the original `.hbc` bytes and builds analysis +
// frames lazily, once, on first use (mirrors `NameService`'s own resident
// pattern).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { analyseModule } from "../cfg/index.ts";
import type { FunctionCfg, ModuleAnalysis } from "../cfg/types.ts";
import { parseHbc } from "../parse/module.ts";
import type { HbcModule } from "../parse/types.ts";
import { rawFrames, type RawFrame } from "../name-overlay/frames.ts";
import { renderFrame, renderedRegisterNames, type ActiveNames, type CollisionFlag } from "../name-overlay/render.ts";
import { astPassHook, enabledPasses, type AstPassHook, type PassPipelineOptions } from "../passes/index.ts";
import { OverlayStore } from "../name-overlay/store.ts";
import { printModule } from "../disasm/print.ts";
import type { LineMapEntry } from "../emit/origin.ts";
import { listNameable, contextSites, type NameableRegister as FrameNameableRegister } from "./frame-queries.ts";
import { sha256Hex } from "./schema.ts";
import {
  checkDbStaleness,
  hasProjectDb,
  loadIndexRowsFromDb,
  openProjectDbReadonly,
  readMeta,
  synthesizeManifestFromMeta,
  type DbIndexRows,
} from "../projdb/artifact-read.ts";
import type {
  CallRow,
  ResolvedCallRow,
  FunctionRow,
  GlobalRow,
  Manifest,
  ModulesIndex,
  NativeRow,
  RangeRow,
  StringRow,
  StringUseRow,
  StringUseRole,
  StringsIndex,
} from "./schema.ts";
import { exportedNamesOf } from "./exported-names.ts";
import { scanObjectTables, type ObjectTableRow, type ObjectTableScan } from "./object-tables.ts";
import { walkFunction, type StringUseSite as WalkStringUseSite } from "./semantic-walk.ts";
import { compareTemplateInjections, scanTemplateInjections, type TemplateInjectionRow, type TemplateInjectionScan } from "./template-injections.ts";
import { parseNativeJsonl, type NativeManifest, type NativeModuleRow, type NativeResourceRow, type SeamRow, type SeamStatus } from "../native/schema.ts";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readJsonlRows<T>(path: string): { readonly header: { readonly kind: string; readonly renderHash?: string }; readonly rows: readonly T[] } {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const header = JSON.parse(lines[0] as string) as { kind: string; renderHash?: string };
  const rows = lines
    .slice(1)
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T);
  return { header, rows };
}

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
  /** The function header's byte offset into the `.hbc` file
   *  (`FunctionRow.offset`, §2.1 — already recorded by every build path,
   *  never re-derived here). Additive field: `view.copyDisasmOffset`
   *  (docs/UI.md) formats it as `fn:<n>@0x<hex>`. */
  readonly offset: number;
}

/** A `who-calls`/`calls-from` row: `fn:N file:line kind[ why]`. `fn`/`file`/
 *  `line` are null for a non-fnIndex callee (`g:`/`m:`/`b:`/`?`). */
export interface Edge {
  readonly fn: number | string;
  readonly file: string | null;
  readonly line: number | null;
  readonly kind: string;
  readonly why?: string;
  /** Present ONLY on an edge recovered by the `require(N)` points-to pass
   *  (`index/calls-resolved.jsonl`, spec 17 §14.4): the receiver was proven
   *  to be module `module`'s export `name`. An edge WITHOUT this marker is
   *  exactly what `who-calls`/`calls-from` always returned (a direct
   *  `calls.jsonl` edge) — consumers that ignore the field see no change. */
  readonly confidence?: "points-to";
  /** §14.4: the export name the call went through (points-to edges only).
   *  Named `exportName`, not `name`, because the MCP/UI `XrefEdge` this is
   *  inlined into already uses `name` for the neighbour FUNCTION's name. */
  readonly exportName?: string;
  /** §14.4: the module whose export was called (points-to edges only). */
  readonly module?: number;
}

/** A `who-calls-by-name` candidate caller (docs/specs/17-mcp-harness.md §14):
 *  a function that READS property `name` (`<slot>.name(...)` dispatch), which
 *  is only a NAME-match, never a resolved call edge — `confidence: "by-name"`
 *  says exactly that. */
export interface ByNameCaller {
  readonly fn: number;
  readonly name: string;
  readonly role: StringUseRole;
  readonly n: number;
  readonly file: string | null;
  readonly line: number | null;
  readonly confidence: "by-name";
}

/** One export name considered by `who-calls-by-name`; `ambiguous` names are
 *  reported (with `why`) but contribute NO candidate rows (§14: say so rather
 *  than dump noise). */
export interface ByNameEntry {
  readonly name: string;
  readonly sid: number | null;
  readonly ambiguous: boolean;
  readonly why?: string;
}

/** §3.1 `query string-uses <sid>` row (hunt-tooling-backlog gap #2): one
 *  instruction-level use site, sorted `(fn, pc)`. `moduleId` is `null` when
 *  `fnOwnership`/`FunctionRow.module` records none for `fn` (`moduleOfFn`). */
export interface StringUseSite {
  readonly fn: number;
  readonly fnName: string | null;
  readonly pc: number;
  readonly opcode: string;
  readonly role: StringUseRole;
  readonly moduleId: number | null;
}

export interface WhoCallsByNameResult extends Bounded<ByNameCaller> {
  /** The export names the scan covered (fn form: proven from bytecode; name
   *  form: the single `--name` argument). */
  readonly names: readonly ByNameEntry[];
  /** The exporting module excluded from candidates (fn form only). */
  readonly excludedModule: number | null;
}

/** JS names so common that a `property-get` of them proves nothing about
 *  dynamic dispatch to a specific module export (§14 known false-positive
 *  class). A `who-calls-by-name` on any of these is `ambiguous`. */
const AMBIGUOUS_NAMES = new Set<string>([
  "default", "get", "set", "map", "then", "catch", "length", "name", "value",
  "type", "id", "key", "data", "index", "push", "pop", "call", "apply", "bind",
  "toString", "valueOf", "constructor", "prototype", "forEach", "filter",
  "reduce", "keys", "values", "entries", "has", "add", "delete", "size",
  "next", "done", "exports", "props", "state", "context", "child", "children",
  "current", "target", "source", "start", "end", "close", "open", "on", "off",
  "emit", "test", "exec", "join", "split", "slice", "concat", "indexOf",
]);
/** Above this many DISTINCT candidate functions, a name is treated as too
 *  common to be a useful dispatch signal (§14). */
const BY_NAME_FANOUT_LIMIT = 200;

/** Options for `query object-tables` (spec 10 §3.1): the default filter keeps
 *  literals that look like CONSTANT TABLES — at least `minProps` members, at
 *  least `stringRatio` of them string-valued — and `key`/`value` narrow that
 *  to the ones a hunt is actually after (`PATH_*` keys, `/…`/`http…`
 *  values). Both patterns are ECMAScript regexes; a table matches if ANY of
 *  its members does. */
export interface ObjectTablesOptions {
  readonly minProps?: number;
  readonly stringRatio?: number;
  readonly key?: string;
  readonly value?: string;
  readonly module?: number;
  /** Minimum number of members that must SATISFY `key`/`value` (default 1).
   *  Guards the accidental hit: a 2,125-member HTML-entity table where one
   *  member happens to be `&sol;: "/"` is not an endpoint table. Without a
   *  key/value filter every member counts as matched, so this is a no-op. */
  readonly minMatched?: number;
  readonly limit?: number;
}

/** A scan row plus how many of its members satisfied the query's
 *  `key`/`value` patterns — the field the RANKING is built on, and the
 *  reason a filtered query does not simply sort by size. */
export interface ObjectTableMatch extends ObjectTableRow {
  /** Members satisfying at least one of the supplied patterns; the table's
   *  own member count when neither `key` nor `value` was given (that is
   *  `numProps` for a table with no computed tail). */
  readonly matched: number;
}

export interface ObjectTablesResult {
  readonly tables: readonly ObjectTableMatch[];
  readonly total: number;
  readonly truncated: boolean;
  /** Functions the underlying scan decoded (`failed` = the ones it could
   *  not, skipped rather than fatal). */
  readonly scanned: number;
  readonly failed: number;
}

/** `query object-tables` defaults (spec 10 §3.1). */
export const OBJECT_TABLE_DEFAULTS = { minProps: 4, stringRatio: 0.5, minMatched: 1, limit: 100 } as const;

/** Options for `query template-injections` (spec 17 §14.3): the WebView-
 *  injection anti-pattern lead (hunt lead C1) — a template literal / `+`
 *  chain whose static text quotes a hole. */
export interface TemplateInjectionsOptions {
  readonly module?: number;
  readonly limit?: number;
  readonly all?: boolean;
}

export interface TemplateInjectionsResult {
  readonly rows: readonly TemplateInjectionRow[];
  readonly total: number;
  readonly truncated: boolean;
  /** Functions the underlying scan decoded (`failed` = the ones it could
   *  not, skipped rather than fatal). */
  readonly scanned: number;
  readonly failed: number;
}

/** `query template-injections` default cap (spec 17 §14.3). */
export const TEMPLATE_INJECTIONS_DEFAULT_LIMIT = 100;

export interface Bounded<T> {
  readonly rows: readonly T[];
  readonly total: number;
  readonly truncated: boolean;
}

/** §3.1 output caps — the number of DATA rows a default (non `--all`/`--page`)
 *  call returns; the CLI appends the `total`/truncation line on top. */
export const CAPS = {
  whoCalls: 50,
  whoCallsByName: 50,
  callsFrom: 50,
  string: 30,
  stringUses: 50,
  stringGrep: 50,
  globalUses: 50,
  native: 50,
  objectTables: OBJECT_TABLE_DEFAULTS.limit,
  nativeModules: 100,
  seams: 100,
  nativeResources: 50,
} as const;

function fnDir(artifactDir: string): string {
  return join(artifactDir, "index");
}

/** The `object-tables` ranking (spec 10 §3.1). Unfiltered: biggest table
 *  first — nothing else is known about relevance. FILTERED: how much of the
 *  table the query actually hit — `matched` first, then the DENSITY of the
 *  hit (`matched / members`), then size. Without the density term a
 *  2,125-member HTML-entity table whose `&sol;` member is `"/"` outranks a
 *  41-member `PATH_*` endpoint table on a `--value '^/'` query, which is the
 *  wrong answer to the question being asked (reported on the live NSW
 *  ui-server, 2026-09-04). Ties break on `fn` then `offset`, so the order is
 *  total and render-independent. */
export function compareObjectTables(filtered: boolean): (a: ObjectTableMatch, b: ObjectTableMatch) => number {
  return (a, b) => {
    if (filtered) {
      const byMatched = b.matched - a.matched;
      if (byMatched !== 0) return byMatched;
      const byDensity = b.matched / b.members.length - a.matched / a.members.length;
      if (byDensity !== 0) return byDensity;
    }
    return b.members.length - a.members.length || a.fn - b.fn || a.offset - b.offset;
  };
}

export class ArtifactService {
  readonly manifest: Manifest;
  private readonly functionsByFn = new Map<number, FunctionRow>();
  private readonly callersByCallee = new Map<number, CallRow[]>();
  private readonly callsByCaller = new Map<number, CallRow[]>();
  /** §2.2a points-to edges, indexed both ways. Empty when the artifact has no
   *  `index/calls-resolved.jsonl` (an artifact built before the pass existed,
   *  or a DB-backed one) — every query then behaves exactly as it did. */
  private readonly resolvedByCallee = new Map<number, ResolvedCallRow[]>();
  private readonly resolvedByCaller = new Map<number, ResolvedCallRow[]>();
  private readonly stringsById = new Map<number, StringRow>();
  private stringUses!: readonly StringUseRow[];
  private globals!: readonly GlobalRow[];
  private nativeRows!: readonly NativeRow[];
  private modulesIndex!: ModulesIndex;
  /** Bundle-wide `?`-callee edge count (§4.2's own note: ANY unresolved
   *  callee could, in principle, be a call to the fn `who-calls` is asked
   *  about — the completeness caveat is necessarily graph-wide, not
   *  per-caller). */
  private totalUnknownCallees = 0;
  private readonly rangesByFn = new Map<number, RangeRow>();
  private readonly artifactDir: string;
  private readonly hbcPath: string | undefined;
  private analysis: ModuleAnalysis | undefined;
  private frames: Map<number, readonly import("../emit/ast.ts").Stmt[]> | undefined;
  private rawFrameMap: Map<number, RawFrame> | undefined;
  private astHook: AstPassHook | undefined;
  /** Injected by `ProjectService` (DB-backed): the ACCEPTED `reg:F:R` names
   *  for one function, read live from `d_names`. Absent = no external names,
   *  and every render path below is exactly what it was before. */
  private activeNames: ((fn: number) => ActiveNames) | undefined;
  private readonly renderCache = new Map<number, { readonly code: string; readonly collisions: readonly CollisionFlag[]; readonly lineMap: readonly LineMapEntry[] }>();
  private hbcModule: HbcModule | undefined;
  private overlay: OverlayStore | undefined;
  private warmPromise: Promise<void> | undefined;
  /** Test-only observability hook: how many times `ensureFrames` actually ran
   *  `analyseModule` (never more than once per instance — its own
   *  `this.analysis === undefined` guard is the real invariant; this counter
   *  lets a test assert that a prewarm plus a concurrent request never race
   *  into two computations, docs/UI.md "Cold start"). */
  private analyseCount = 0;

  /** §4.3 backend selection: `.hbcproj` present → DB-backed; else the
   *  JSONL path (unchanged). Exposed for callers that need to know without
   *  constructing the service (e.g. `ProjectService`'s own selection). */
  readonly dbBacked: boolean;

  constructor(artifactDir: string, opts: { readonly hbc?: string; readonly overlayStorePath?: string } = {}) {
    this.artifactDir = artifactDir;
    this.hbcPath = opts.hbc;
    const manifestPath = join(artifactDir, "manifest.json");
    const manifestExists = existsSync(manifestPath);
    this.dbBacked = hasProjectDb(artifactDir);

    if (!this.dbBacked && !manifestExists) {
      throw new Hbc2jsError(ErrorCode.E_IO, `${artifactDir} has no manifest.json — not an artifact (docs/specs/10-artifact-format.md §1.2)`);
    }

    if (this.dbBacked) {
      // §3.2/§5.2: prepared-statement read path over `project.hbcproj`'s
      // `ix_*` tables — see `src/projdb/artifact-read.ts`. §4.3: once
      // `.hbcproj` exists, `index/*.jsonl` in the same dir is ignored.
      const db = openProjectDbReadonly(artifactDir);
      const meta = readMeta(db);
      this.manifest = manifestExists ? readJson<Manifest>(manifestPath) : synthesizeManifestFromMeta(meta);
      if (manifestExists) checkDbStaleness(artifactDir, meta, this.manifest);
      const rows = loadIndexRowsFromDb(db);
      db.close();
      this.populateFromRows(rows);
    } else {
      this.manifest = readJson<Manifest>(manifestPath);

      const dir = fnDir(artifactDir);
      const { rows: functionRows } = readJsonlRows<FunctionRow>(join(dir, "functions.jsonl"));
      const { rows: callRows } = readJsonlRows<CallRow>(join(dir, "calls.jsonl"));
      const stringsIndex = readJson<StringsIndex>(join(dir, "strings.json"));
      const { rows: stringUseRows } = readJsonlRows<StringUseRow>(join(dir, "string-uses.jsonl"));
      const { rows: globalRows } = readJsonlRows<GlobalRow>(join(dir, "globals.jsonl"));
      const { rows: nativeRows } = readJsonlRows<NativeRow>(join(dir, "native.jsonl"));
      // §2.2a: OPTIONAL by construction — an artifact written before the
      // points-to pass existed has no such file and must keep working.
      const resolvedPath = join(dir, "calls-resolved.jsonl");
      const resolvedCallRows = existsSync(resolvedPath) ? readJsonlRows<ResolvedCallRow>(resolvedPath).rows : [];
      const modulesIndex = readJson<ModulesIndex>(join(dir, "modules.json"));

      // §4.2 staleness: ranges header renderHash must equal manifest render.hash.
      const { header: rangesHeader, rows: rangeRows } = readJsonlRows<RangeRow>(join(dir, "ranges.jsonl"));
      if (rangesHeader.renderHash !== this.manifest.render.hash) {
        throw new Hbc2jsError(
          ErrorCode.E_STALE_RANGES,
          `${artifactDir}: ranges.jsonl renderHash (${rangesHeader.renderHash}) != manifest.render.hash (${this.manifest.render.hash}) — ` +
            `run \`hbc2js render\` to regenerate ranges before querying (docs/specs/10-artifact-format.md §4.2)`,
        );
      }

      // index.builtFor must agree with the manifest's own bundle+producer —
      // guards a hand-edited or half-written manifest (§4.2).
      const producerHash = this.manifest.index.builtFor.producer;
      const expectedProducerHash = sha256OfProducer(this.manifest.producer);
      if (this.manifest.index.builtFor.bundleSha256 !== this.manifest.bundle.sha256 || producerHash !== expectedProducerHash) {
        throw new Hbc2jsError(
          ErrorCode.E_STALE_INDEX,
          `${artifactDir}: index.builtFor does not match this manifest's bundle/producer — the semantic layer is stale ` +
            `(docs/specs/10-artifact-format.md §4.2); re-decompile into a fresh artifact directory`,
        );
      }

      this.populateFromRows({ functionRows, callRows, stringsIndex, stringUseRows, globalRows, nativeRows, modulesIndex, rangeRows }, resolvedCallRows);
    }

    if (opts.overlayStorePath !== undefined && existsSync(opts.overlayStorePath)) {
      this.overlay = OverlayStore.load(opts.overlayStorePath, opts.hbc);

      // §4.2 staleness, the overlay-hash half (docs/BUGS.md 2026-09-03
      // "overlayHash always null" row): a `name set` changes the overlay
      // store's content without touching `ranges.jsonl`/`render.hash` (a
      // rename alone never reprints anything) — the ranges check above
      // cannot see that, so this is the only place a stale-after-rename
      // artifact gets caught. Only enforced when the manifest actually
      // recorded a hash (an artifact built with no overlay in scope has
      // `overlayHash: null` and stays valid against a store that starts
      // existing later — `manifest.render.overlayHash` is null. Nothing to
      // compare it against).
      if (this.manifest.render.overlayHash !== null) {
        const currentOverlayHash = sha256Hex(readFileSync(opts.overlayStorePath, "utf8"));
        if (currentOverlayHash !== this.manifest.render.overlayHash) {
          throw new Hbc2jsError(
            ErrorCode.E_STALE_INDEX,
            `${artifactDir}: overlay store content hash (${currentOverlayHash}) != manifest.render.overlayHash ` +
              `(${this.manifest.render.overlayHash}) — a name was renamed after this artifact was rendered; run ` +
              `\`hbc2js render\` (or re-write the artifact) before querying (docs/specs/10-artifact-format.md §4.2)`,
          );
        }
      }
    }
  }

  /** Populates every private map from one row bundle, whichever backend
   *  produced it (JSONL reads or `src/projdb/artifact-read.ts`'s DB reads)
   *  — the ONE place caps/slicing-relevant state is built, so every verb
   *  below answers identically regardless of backend (§3.2). */
  private populateFromRows(rows: DbIndexRows, resolvedCallRows: readonly ResolvedCallRow[] = []): void {
    for (const r of rows.functionRows) this.functionsByFn.set(r.fn, r);
    for (const c of rows.callRows) {
      const list = this.callsByCaller.get(c.caller) ?? [];
      list.push(c);
      this.callsByCaller.set(c.caller, list);
      if (typeof c.callee === "number") {
        const inList = this.callersByCallee.get(c.callee) ?? [];
        inList.push(c);
        this.callersByCallee.set(c.callee, inList);
      }
      if (c.callee === "?") this.totalUnknownCallees++;
    }
    for (const e of rows.stringsIndex.entries) this.stringsById.set(e.sid, e);
    this.stringUses = rows.stringUseRows;
    this.globals = rows.globalRows;
    this.nativeRows = rows.nativeRows;
    this.modulesIndex = rows.modulesIndex;
    for (const r of rows.rangeRows) this.rangesByFn.set(r.fn, r);
    for (const r of resolvedCallRows) {
      const out = this.resolvedByCaller.get(r.caller) ?? [];
      out.push(r);
      this.resolvedByCaller.set(r.caller, out);
      const inList = this.resolvedByCallee.get(r.callee) ?? [];
      inList.push(r);
      this.resolvedByCallee.set(r.callee, inList);
    }
  }

  private range(fn: number): RangeRow | undefined {
    return this.rangesByFn.get(fn);
  }

  /** §3.1 `query fn <fn>`. */
  fn(fn: number): FnSummary {
    const row = this.functionsByFn.get(fn);
    if (row === undefined) throw new Hbc2jsError(ErrorCode.E_USAGE, `query fn: no such function ${fn} in this artifact`);
    const range = this.range(fn);
    const edgesOut = this.callsByCaller.get(fn)?.length ?? 0;
    const edgesIn = this.callersByCallee.get(fn)?.length ?? 0;
    const nativeSurfaceCount = this.nativeRows.filter((n) => n.fn === fn).length;
    const degraded = (this.manifest.degraded ?? []).length > 0 ? (this.manifest.degraded as readonly string[]).join("; ") : null;
    // §3.1 overlayName: query-level live join with the overlay store; a
    // function summary has no single register, so this reports whether ANY
    // register in the function has been named (a coarse but honest signal —
    // `name list <fn>` gives the per-register detail).
    let overlayName: string | null = null;
    if (this.overlay !== undefined) {
      for (const r of this.overlay.search({ fn })) {
        overlayName = r.name;
        break;
      }
    }
    return {
      fn,
      name: row.name,
      overlayName,
      module: row.module,
      file: range?.file ?? null,
      lines: range?.lines ?? null,
      params: row.params,
      kind: row.kind,
      edgesIn,
      edgesOut,
      nativeSurfaceCount,
      degraded,
      offset: row.offset,
    };
  }

  private edgeFromCall(c: CallRow, other: "callee" | "caller"): Edge {
    const fnRef = other === "callee" ? c.callee : c.caller;
    if (typeof fnRef === "number") {
      const r = this.range(fnRef);
      return { fn: fnRef, file: r?.file ?? null, line: r?.lines[0] ?? null, kind: other === "callee" ? c.kind : c.kind, ...(c.why !== undefined ? { why: c.why } : {}) };
    }
    return { fn: fnRef, file: null, line: null, kind: c.kind, ...(c.why !== undefined ? { why: c.why } : {}) };
  }

  /** §14.4: one `index/calls-resolved.jsonl` row as an `Edge`. `kind` is
   *  `"method"` (the call really is a property call on the module's exports);
   *  `confidence: "points-to"` is what tells the two apart. */
  private edgeFromResolved(r: ResolvedCallRow, other: "callee" | "caller"): Edge {
    const fnRef = other === "callee" ? r.callee : r.caller;
    const range = this.range(fnRef);
    return { fn: fnRef, file: range?.file ?? null, line: range?.lines[0] ?? null, kind: "method", confidence: "points-to", exportName: r.name, module: r.module };
  }

  /** §3.1 `query who-calls <fn>` — inverts calls.jsonl (§2.2's own note),
   *  then appends the §2.2a points-to edges whose callee is `fn` (spec 17
   *  §14.4). Direct edges stay first and unchanged. */
  whoCalls(fn: number, opts: { readonly all?: boolean } = {}): Bounded<Edge> & { readonly unknownInScope: number } {
    const rows = this.callersByCallee.get(fn) ?? [];
    const edges = [...rows.map((c) => this.edgeFromCall({ ...c, callee: fn }, "caller")), ...(this.resolvedByCallee.get(fn) ?? []).map((r) => this.edgeFromResolved(r, "caller"))];
    const cap = opts.all === true ? edges.length : CAPS.whoCalls;
    return { rows: edges.slice(0, cap), total: edges.length, truncated: edges.length > cap, unknownInScope: this.totalUnknownCallees };
  }

  /** §3.1 `query calls-from <fn>`. */
  callsFrom(fn: number, opts: { readonly all?: boolean } = {}): Bounded<Edge> {
    const rows = this.callsByCaller.get(fn) ?? [];
    const edges = [...rows.map((c) => this.edgeFromCall(c, "callee")), ...(this.resolvedByCaller.get(fn) ?? []).map((r) => this.edgeFromResolved(r, "callee"))];
    const cap = opts.all === true ? edges.length : CAPS.callsFrom;
    return { rows: edges.slice(0, cap), total: edges.length, truncated: edges.length > cap };
  }

  /** §3.1 `query string <sid>`. */
  string(sid: number): { readonly value: StringRow | undefined; readonly uses: Bounded<StringUseRow> } {
    const value = this.stringsById.get(sid);
    const rows = this.stringUses.filter((r) => r.sid === sid);
    return { value, uses: { rows: rows.slice(0, CAPS.string), total: rows.length, truncated: rows.length > CAPS.string } };
  }

  /** Strings used BY a given fn — not a spec-10 §3.1 CLI verb of its own,
   *  but the read `context/{fn}` (docs/specs/17-mcp-harness.md §1/§14) needs
   *  to fill its "strings-used" slice without a new answer: same
   *  `ix_string_uses`/`stringUses` rows `string(sid)` already serves,
   *  inverted by fn instead of by sid, capped the same as `string`'s own
   *  `uses` cap (§3.1's "union of the component caps"). */
  stringsUsedBy(fn: number, opts: { readonly all?: boolean } = {}): Bounded<{ readonly sid: number; readonly head: string; readonly role: string; readonly n: number }> {
    const rows = this.stringUses
      .filter((r) => r.fn === fn)
      .map((r) => {
        const s = this.stringsById.get(r.sid);
        const text = s === undefined ? "" : "v" in s ? s.v : s.head;
        return { sid: r.sid, head: text.length > 80 ? text.slice(0, 80) : text, role: r.role, n: r.n };
      });
    const cap = opts.all === true ? rows.length : CAPS.string;
    return { rows: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
  }

  /** §3.1 `query string-uses <sid>` (hunt-tooling-backlog gap #2): the use
   *  SITES, not just the `(fn, role) -> n` counts `string(sid).uses`
   *  already gives. The artifact format is unchanged (spec 10 §2.3b keeps
   *  site detail off disk on purpose) — this computes sites ON DEMAND by
   *  re-walking each candidate function's bytecode with the SAME classifier
   *  that produced `string-uses.jsonl` (`walkFunction`'s `bumpString`
   *  call sites, via its `onSite` hook), so it can never disagree with the
   *  counts. Live verb: needs `--hbc` (`ensureModule`/`ensureAnalysis`
   *  throw the usual `E_USAGE` otherwise). `opts.fn` narrows to one
   *  function (scanned even if `string-uses.jsonl` has no row for it —
   *  an explicit `--fn` is the caller vouching for the candidate); default
   *  scans every fn `string-uses.jsonl` lists for this `sid`. */
  stringUseSites(sid: number, opts: { readonly fn?: number; readonly all?: boolean } = {}): Bounded<StringUseSite> {
    const module = this.ensureModule("string-uses");
    const analysis = this.ensureAnalysis("string-uses");
    const fnsToScan =
      opts.fn !== undefined ? [opts.fn] : [...new Set(this.stringUses.filter((r) => r.sid === sid).map((r) => r.fn))].sort((a, b) => a - b);
    const sites: StringUseSite[] = [];
    for (const fnIndex of fnsToScan) {
      walkFunction(module, analysis, fnIndex, undefined, (u: WalkStringUseSite) => {
        if (u.sid !== sid) return;
        sites.push({
          fn: fnIndex,
          fnName: this.functionsByFn.get(fnIndex)?.name ?? null,
          pc: u.pc,
          opcode: u.opcode,
          role: u.role,
          moduleId: this.moduleOfFn(fnIndex),
        });
      });
    }
    sites.sort((a, b) => a.fn - b.fn || a.pc - b.pc);
    const cap = opts.all === true ? sites.length : CAPS.stringUses;
    return { rows: sites.slice(0, cap), total: sites.length, truncated: sites.length > cap };
  }

  /** §3.1 `query string-grep <regex>`. */
  stringGrep(pattern: string, opts: { readonly all?: boolean } = {}): Bounded<{ readonly sid: number; readonly head: string; readonly uses: number }> {
    const re = new RegExp(pattern);
    const usesBySid = new Map<number, number>();
    for (const u of this.stringUses) usesBySid.set(u.sid, (usesBySid.get(u.sid) ?? 0) + u.n);
    const matches: { sid: number; head: string; uses: number }[] = [];
    for (const [sid, e] of this.stringsById) {
      const text = "v" in e ? e.v : e.head;
      if (re.test(text)) matches.push({ sid, head: text.length > 80 ? text.slice(0, 80) : text, uses: usesBySid.get(sid) ?? 0 });
    }
    matches.sort((a, b) => a.sid - b.sid);
    const cap = opts.all === true ? matches.length : CAPS.stringGrep;
    return { rows: matches.slice(0, cap), total: matches.length, truncated: matches.length > cap };
  }

  /** §3.1 `query global-uses <name>` — `file:line` is the OWNING FUNCTION's
   *  range (§3.3: site-level global positions are not materialised; use
   *  `context` for site detail on a specific register). */
  globalUses(name: string, opts: { readonly all?: boolean } = {}): Bounded<{ readonly fn: number; readonly access: string; readonly n: number; readonly file: string | null; readonly line: number | null }> {
    const rows = this.globals
      .filter((g) => g.g === name)
      .map((g) => {
        const r = this.range(g.fn);
        return { fn: g.fn, access: g.access, n: g.n, file: r?.file ?? null, line: r?.lines[0] ?? null };
      });
    const cap = opts.all === true ? rows.length : CAPS.globalUses;
    return { rows: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
  }

  /** Reverse of the strings index: an exact (untruncated) string value -> its
   *  sid. Names under which a module exports are short, so the truncated-head
   *  entries are never candidates and are skipped. Built once, lazily. */
  private valueToSidCache: Map<string, number> | undefined;
  private valueToSid(): Map<string, number> {
    if (this.valueToSidCache === undefined) {
      const m = new Map<string, number>();
      for (const [sid, e] of this.stringsById) if ("v" in e) m.set(e.v, sid);
      this.valueToSidCache = m;
    }
    return this.valueToSidCache;
  }

  /** The module a function is owned by, `null` if the index does not record
   *  one (uses `FunctionRow.module` first, then `fnOwnership`). */
  private moduleOfFn(fn: number): number | null {
    const row = this.functionsByFn.get(fn);
    if (row?.module != null) return row.module;
    const owned = this.modulesIndex.fnOwnership[String(fn)];
    return owned ?? null;
  }

  /** All candidate callers of a single export `name`: functions that read it
   *  as a property (`<slot>.name(...)` dispatch), grouped and summed by fn,
   *  minus any function in `excludeModule`. Returns the raw (uncapped) rows
   *  plus the distinct-fn count, so the caller can apply the fan-out
   *  ambiguity rule before deciding whether to keep them. */
  private byNameCandidates(name: string, sid: number, excludeModule: number | null): ByNameCaller[] {
    const byFn = new Map<number, number>();
    for (const u of this.stringUses) {
      if (u.sid !== sid || u.role !== "property-get") continue;
      if (excludeModule !== null && this.moduleOfFn(u.fn) === excludeModule) continue;
      byFn.set(u.fn, (byFn.get(u.fn) ?? 0) + u.n);
    }
    const rows: ByNameCaller[] = [];
    for (const [fn, n] of byFn) {
      const r = this.range(fn);
      rows.push({ fn, name, role: "property-get", n, file: r?.file ?? null, line: r?.lines[0] ?? null, confidence: "by-name" });
    }
    rows.sort((a, b) => a.fn - b.fn);
    return rows;
  }

  /** docs/specs/17-mcp-harness.md §14: NAME-based caller recovery for the
   *  `require-once-into-a-slot` then `<slot>.export(...)` dispatch convention
   *  that `who-calls` returns `total:0` for. Two forms:
   *   - `{ fn }`: prove (from bytecode, one lazy walk of the fn's lexical
   *     parent + its module factory) the names N is exported under, then scan
   *     every OTHER module's `property-get` uses of those names.
   *   - `{ name }`: the same scan for one caller-supplied name (no step 1).
   *  Every row is `confidence: "by-name"` — a name match, never a resolved
   *  edge. Common/high-fan-out names are reported `ambiguous` with no rows. */
  whoCallsByName(target: { readonly fn: number } | { readonly name: string }, opts: { readonly all?: boolean } = {}): WhoCallsByNameResult {
    let excludedModule: number | null = null;
    let exportNames: readonly string[];

    if ("fn" in target) {
      if (!this.functionsByFn.has(target.fn)) {
        throw new Hbc2jsError(ErrorCode.E_USAGE, `who-calls-by-name: no such function ${target.fn} in this artifact`);
      }
      // Step 1 needs the bytecode def-use chain (live verb, §3.3) — same
      // `--hbc` requirement as `list`/`context`.
      const module = this.ensureModule("who-calls-by-name");
      const { analysis } = this.ensureFrames();
      excludedModule = this.moduleOfFn(target.fn);
      const row = this.functionsByFn.get(target.fn)!;
      const hosts: number[] = [];
      if (row.parent != null) hosts.push(row.parent);
      if (excludedModule !== null) {
        const modEntry = this.modulesIndex.modules.find((m) => m.id === excludedModule);
        if (modEntry?.factoryFn != null && !hosts.includes(modEntry.factoryFn)) hosts.push(modEntry.factoryFn);
      }
      exportNames = exportedNamesOf(module, analysis, target.fn, hosts).map((e) => e.name);
      // Deduplicate names (property-put + property-key of the same name).
      exportNames = [...new Set(exportNames)];
    } else {
      exportNames = [target.name];
    }

    const v2s = this.valueToSid();
    const names: ByNameEntry[] = [];
    const allRows: ByNameCaller[] = [];
    for (const name of exportNames) {
      const sid = v2s.get(name);
      if (sid === undefined) {
        names.push({ name, sid: null, ambiguous: false, why: "no such string in this bundle" });
        continue;
      }
      if (AMBIGUOUS_NAMES.has(name)) {
        names.push({ name, sid, ambiguous: true, why: "common JS name (dispatch-agnostic)" });
        continue;
      }
      const rows = this.byNameCandidates(name, sid, excludedModule);
      if (rows.length > BY_NAME_FANOUT_LIMIT) {
        names.push({ name, sid, ambiguous: true, why: `read as a property in ${rows.length} functions (> ${BY_NAME_FANOUT_LIMIT})` });
        continue;
      }
      names.push({ name, sid, ambiguous: false });
      allRows.push(...rows);
    }
    // Merge duplicate (fn,name) rows that two host walks could produce, then
    // sort by fn (stable, render-independent).
    allRows.sort((a, b) => a.fn - b.fn || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const cap = opts.all === true ? allRows.length : CAPS.whoCallsByName;
    return { rows: allRows.slice(0, cap), total: allRows.length, truncated: allRows.length > cap, names, excludedModule };
  }

  /** The one bundle-wide `NewObjectWithBuffer*` scan, memoised: it is
   *  O(instructions) (measured 96 ms / 15,551 functions on
   *  react-navigation-example-0.85.3), so every later filtered query is a
   *  filter over an array. Live verb — needs `--hbc` like `list`/`context`,
   *  because the literal buffers are bytecode, not artifact rows. */
  private objectTableScan: ObjectTableScan | undefined;
  private ensureObjectTables(): ObjectTableScan {
    if (this.objectTableScan === undefined) {
      const module = this.ensureModule("object-tables");
      this.objectTableScan = scanObjectTables(module, (fn) => this.moduleOfFn(fn));
    }
    return this.objectTableScan;
  }

  /** §3.1 `query object-tables` — a bundle-wide inventory of constant object
   *  literals (docs/specs/hunt-tooling-backlog.md "endpoint-tables": the hunt
   *  needs to SEE every endpoint table, not grep for the one key it already
   *  guessed). Sorted most-members-first so the real tables lead. */
  objectTables(opts: ObjectTablesOptions = {}): ObjectTablesResult {
    const scan = this.ensureObjectTables();
    const minProps = opts.minProps ?? OBJECT_TABLE_DEFAULTS.minProps;
    const stringRatio = opts.stringRatio ?? OBJECT_TABLE_DEFAULTS.stringRatio;
    const minMatched = opts.minMatched ?? OBJECT_TABLE_DEFAULTS.minMatched;
    const limit = opts.limit ?? OBJECT_TABLE_DEFAULTS.limit;
    let keyRe: RegExp | undefined;
    let valueRe: RegExp | undefined;
    try {
      if (opts.key !== undefined) keyRe = new RegExp(opts.key);
      if (opts.value !== undefined) valueRe = new RegExp(opts.value);
    } catch (e) {
      throw new Hbc2jsError(ErrorCode.E_USAGE, `object-tables: bad regex — ${e instanceof Error ? e.message : String(e)}`);
    }
    const filtered = keyRe !== undefined || valueRe !== undefined;

    const rows: ObjectTableMatch[] = [];
    for (const r of scan.rows) {
      const n = r.members.length;
      if (n < minProps) continue;
      if (n === 0 || r.strings / n < stringRatio) continue;
      if (opts.module !== undefined && r.module !== opts.module) continue;
      // Both patterns must be satisfied by the table (possibly by different
      // members, as before); `matched` counts the members satisfying EITHER,
      // so a table that passes the filter always has `matched ≥ 1`.
      if (keyRe !== undefined && !r.members.some((m) => keyRe!.test(m.key))) continue;
      if (valueRe !== undefined && !r.members.some((m) => m.value !== null && valueRe!.test(m.value))) continue;
      const matched = filtered
        ? r.members.filter((m) => (keyRe !== undefined && keyRe.test(m.key)) || (valueRe !== undefined && m.value !== null && valueRe.test(m.value))).length
        : n;
      if (matched < minMatched) continue;
      rows.push({ ...r, matched });
    }

    rows.sort(compareObjectTables(filtered));
    return {
      tables: rows.slice(0, limit),
      total: rows.length,
      truncated: rows.length > limit,
      scanned: scan.scanned,
      failed: scan.failed,
    };
  }

  /** The one bundle-wide `template-injections` scan, memoised the same way
   *  `objectTables` is: O(instructions), so every later filtered query is a
   *  filter over an array. Live verb — needs `--hbc`, because chunks/holes
   *  are read from the bytecode, not artifact rows. */
  private templateInjectionScan: TemplateInjectionScan | undefined;
  private ensureTemplateInjections(): TemplateInjectionScan {
    if (this.templateInjectionScan === undefined) {
      const module = this.ensureModule("template-injections");
      this.templateInjectionScan = scanTemplateInjections(module, (fn) => this.moduleOfFn(fn));
    }
    return this.templateInjectionScan;
  }

  /** §14.3 `query template-injections` — the WebView-injection anti-pattern
   *  lead (hunt lead C1, docs/specs/hunt-tooling-backlog.md line ~55):
   *  surfaces every template literal / `+` chain whose static text quotes a
   *  substitution. Ranked by substitutions-inside-quotes desc, then `fn`
   *  (`compareTemplateInjections`). */
  templateInjections(opts: TemplateInjectionsOptions = {}): TemplateInjectionsResult {
    const scan = this.ensureTemplateInjections();
    const rows = (opts.module !== undefined ? scan.rows.filter((r) => r.module === opts.module) : scan.rows).slice().sort(compareTemplateInjections);
    const limit = opts.all === true ? rows.length : (opts.limit ?? TEMPLATE_INJECTIONS_DEFAULT_LIMIT);
    return {
      rows: rows.slice(0, limit),
      total: rows.length,
      truncated: rows.length > limit,
      scanned: scan.scanned,
      failed: scan.failed,
    };
  }

  /** §3.1 `query native [--fn N]`. */
  native(opts: { readonly fn?: number; readonly all?: boolean } = {}): Bounded<NativeRow> {
    const rows = opts.fn !== undefined ? this.nativeRows.filter((n) => n.fn === opts.fn) : this.nativeRows;
    const cap = opts.all === true ? rows.length : CAPS.native;
    return { rows: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
  }

  // -- spec 27 L5 -- read verbs over the native/ tables (L1-L4) -----------
  // `native/` is optional-by-construction (spec 27 §1.4): an artifact
  // written from JS bytes alone has no such directory. Every reader here
  // returns `null`/empty rather than throwing on its absence -- "no native
  // side ingested" is a fact, never an error (mirrors `renderedRegisterNames`
  // etc.'s null-is-a-fact idiom elsewhere in this file). Read once, cached,
  // same resident-service shape as every other index below.

  private nativeModulesCache: readonly NativeModuleRow[] | undefined;
  private nativeSeamsCache: readonly SeamRow[] | undefined;
  private nativeManifestCache: NativeManifest | null | undefined;
  private nativeResourcesCache: readonly NativeResourceRow[] | undefined;

  private readNativeJsonl<T>(file: string): readonly T[] {
    const path = join(this.artifactDir, "native", file);
    if (!existsSync(path)) return [];
    return parseNativeJsonl(readFileSync(path, "utf8")).rows as T[];
  }

  private ensureNativeModules(): readonly NativeModuleRow[] {
    if (this.nativeModulesCache === undefined) this.nativeModulesCache = this.readNativeJsonl<NativeModuleRow>("react-modules.jsonl");
    return this.nativeModulesCache;
  }

  private ensureNativeSeams(): readonly SeamRow[] {
    if (this.nativeSeamsCache === undefined) this.nativeSeamsCache = this.readNativeJsonl<SeamRow>("seams.jsonl");
    return this.nativeSeamsCache;
  }

  private ensureNativeResourceRows(): readonly NativeResourceRow[] {
    if (this.nativeResourcesCache === undefined) this.nativeResourcesCache = this.readNativeJsonl<NativeResourceRow>("resources.jsonl");
    return this.nativeResourcesCache;
  }

  /** `native/manifest.json` (the AXML-derived `NativeManifest`, spec 27
   *  §L1) -- NOT this class's own artifact `manifest.json`. `null` when no
   *  native side was ingested into this artifact. */
  ensureNativeManifest(): NativeManifest | null {
    if (this.nativeManifestCache === undefined) {
      const path = join(this.artifactDir, "native", "manifest.json");
      this.nativeManifestCache = existsSync(path) ? readJson<NativeManifest>(path) : null;
    }
    return this.nativeManifestCache;
  }

  /** `query native modules` -- every `native/react-modules.jsonl` row, spec
   *  10 §3.2 shape (`Bounded<T>`, `CAPS.nativeModules` = 100 rows/call). */
  nativeModules(opts: { readonly all?: boolean } = {}): Bounded<NativeModuleRow> {
    const rows = [...this.ensureNativeModules()].sort((a, b) => a.key.localeCompare(b.key));
    const cap = opts.all === true ? rows.length : CAPS.nativeModules;
    return { rows: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
  }

  /** `query native module <X>` -- one module by its `jsName` (or its raw
   *  `native:module:...` key when `jsName` is `unresolved`), plus every seam
   *  row that names it -- one call, no N+1 follow-up (mirrors §14's xref
   *  fix). `null` when no such module exists in this artifact. */
  nativeModule(x: string): { readonly module: NativeModuleRow; readonly seams: readonly SeamRow[] } | null {
    const mod = this.ensureNativeModules().find((m) => m.jsName === x || m.key === x);
    if (mod === undefined) return null;
    const seams = this.ensureNativeSeams().filter((s) => s.native?.module === mod.key);
    return { module: mod, seams };
  }

  /** `query native seams [--status ...] [--first-party]` -- spec 27 §L5,
   *  `Bounded<SeamRow>` (`CAPS.seams` = 100 rows/call). */
  seams(filter: { readonly status?: SeamStatus; readonly firstParty?: boolean; readonly all?: boolean } = {}): Bounded<SeamRow> {
    let rows = [...this.ensureNativeSeams()];
    if (filter.status !== undefined) rows = rows.filter((r) => r.status === filter.status);
    if (filter.firstParty !== undefined) rows = rows.filter((r) => r.firstParty === filter.firstParty);
    rows.sort((a, b) => a.key.localeCompare(b.key));
    const cap = filter.all === true ? rows.length : CAPS.seams;
    return { rows: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
  }

  /** `query native manifest` -- the whole `NativeManifest`; small and
   *  singular, so it is never bounded/paginated (same shape as `module()`
   *  below). `null` when no native side was ingested. */
  nativeManifest(): NativeManifest | null {
    return this.ensureNativeManifest();
  }

  /** `query native resources --key <re>` -- `native/resources.jsonl` rows
   *  whose `key` matches `pattern` (`CAPS.nativeResources` = 50 rows/call). */
  nativeResources(pattern: string, opts: { readonly all?: boolean } = {}): Bounded<NativeResourceRow> {
    const re = new RegExp(pattern);
    const rows = this.ensureNativeResourceRows()
      .filter((r) => re.test(r.key))
      .sort((a, b) => a.key.localeCompare(b.key));
    const cap = opts.all === true ? rows.length : CAPS.nativeResources;
    return { rows: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
  }

  /** The one native-impl fact the UI Context pane needs for `fn:N` (spec 27
   *  §L5): every seam whose JS evidence cites this function as a call site,
   *  each paired with its native module row when `status:"linked"`. Empty
   *  when this fn participates in no seam, or when no native side was
   *  ingested -- both honest "nothing to show", never an error. */
  nativeImplFor(fn: number): readonly { readonly seam: SeamRow; readonly module: NativeModuleRow | null }[] {
    const modules = new Map(this.ensureNativeModules().map((m) => [m.key, m]));
    const tag = `fn:${fn}`;
    return this.ensureNativeSeams()
      .filter((s) => s.jsEvidence?.callSites.includes(tag) === true)
      .map((s) => ({ seam: s, module: s.native !== null ? (modules.get(s.native.module) ?? null) : null }));
  }

  /** True iff `fn` is a real function index in this artifact — the cheap,
   *  non-throwing existence check `src/project/evidence-resolver.ts` (spec
   *  11 §4.1) needs to resolve a `fn:N`/`reg:F:N` evidence ref without
   *  paying for `fn()`'s full summary or a try/catch. */
  hasFn(fn: number): boolean {
    return this.functionsByFn.has(fn);
  }

  /** True iff `sid` is a real string id — same existence-check shape as
   *  `hasFn` for the evidence resolver's `sid:N` refs. */
  hasString(sid: number): boolean {
    return this.stringsById.has(sid);
  }

  /** True iff `id` names a real module — same shape, for `mod:N` refs. */
  hasModule(id: number): boolean {
    return this.modulesIndex.modules.some((m) => m.id === id);
  }

  /** Every string row, unbounded — same "raw table for a full-table pass"
   *  shape as `listFns`, for a caller (the secrets scanner, docs/BUGS.md
   *  `readStringsIndex`/`readStringUses` row) that needs every string once
   *  regardless of backend: DB-backed or JSONL, `stringsById` is already
   *  populated identically either way by `populateFromRows` above. */
  allStrings(): readonly StringRow[] {
    return [...this.stringsById.values()];
  }

  /** Every string-use row, unbounded — the xref-join source for
   *  `allStrings()`'s callers. Same backend-unifying note applies. */
  allStringUses(): readonly StringUseRow[] {
    return this.stringUses;
  }

  /** Every function's `{fn, name}` — a bare, uncapped name-only projection
   *  (no source/edges/anything else `fn()` computes). Not a spec-10 §3.1
   *  CLI verb of its own: it exists so callers that must WALK every
   *  function once (spec 17 §14's `search/functions`, `search/source`) can
   *  do it without an unbounded catalogue of made-up fn indices — the
   *  caller applies its own cap on the RESULT, this just gives the raw
   *  list to filter. */
  listFns(): readonly { readonly fn: number; readonly name: string | null }[] {
    return [...this.functionsByFn.entries()].map(([fn, row]) => ({ fn, name: row.name }));
  }

  /** Every function a module owns (`fnOwnership`), with its recorded line
   *  range — the cheap walk `/api/module/{id}/source` needs; `fn()` per
   *  function is O(native rows) each and is far too slow for a 15k-fn bundle. */
  ownedFns(id: number): readonly { readonly fn: number; readonly name: string | null; readonly lines: readonly [number, number] | null }[] {
    const out: { fn: number; name: string | null; lines: readonly [number, number] | null }[] = [];
    for (const [key, owner] of Object.entries(this.modulesIndex.fnOwnership)) {
      if (owner !== id) continue;
      const fn = Number(key);
      const r = this.range(fn);
      out.push({ fn, name: this.functionsByFn.get(fn)?.name ?? null, lines: r !== undefined ? r.lines : null });
    }
    return out;
  }

  /** §3.1 `query module <id>`. */
  module(id: number): { readonly deps: readonly number[]; readonly dependents: readonly number[]; readonly ownedFnCount: number; readonly file: string | null } {
    const m = this.modulesIndex.modules.find((x) => x.id === id);
    const dependents = this.modulesIndex.modules.filter((x) => x.deps.includes(id)).map((x) => x.id);
    let ownedFnCount = 0;
    for (const owner of Object.values(this.modulesIndex.fnOwnership)) if (owner === id) ownedFnCount++;
    return { deps: m?.deps ?? [], dependents, ownedFnCount, file: m?.file ?? null };
  }

  /** Where a recorded `file` (always a bare `module_N.js`, spec 10 §2)
   *  lives on disk: the artifact root for `--split` artifacts, `src/` for
   *  `hbc2js init` projects (spec 16 §4.1 renders the split tree under
   *  `<out>/src` but records the same bare names). Both layouts are read
   *  by the same query surface — regression: an `init` project used to
   *  500 on every source read. */
  modulePath(file: string): string {
    const direct = join(this.artifactDir, file);
    if (existsSync(direct)) return direct;
    const underSrc = join(this.artifactDir, "src", file);
    return existsSync(underSrc) ? underSrc : direct;
  }

  /** §3.1 `query source <fn> [--lines a-b]` — the only source-emitting verb;
   *  clipped to the function's own range regardless of the requested slice. */
  source(fn: number, lines?: readonly [number, number]): string {
    const r = this.range(fn);
    if (r === undefined) throw new Hbc2jsError(ErrorCode.E_USAGE, `query source: no range recorded for fn ${fn}`);
    const [lo, hi] = r.lines;
    if (this.activeNamesFor(fn).size > 0) {
      const rendered = this.renderFn(fn);
      if (rendered !== null) {
        const renderedLines = rendered.code.split("\n");
        if (lines === undefined) return rendered.code;
        // `lines` is expressed in the module file's own numbering; clip
        // relative to the function's first line, same window the disk slice
        // below would have returned.
        return renderedLines.slice(Math.max(0, lines[0] - lo), Math.max(0, lines[1] - lo + 1)).join("\n");
      }
    }
    const fileLines = readFileSync(this.modulePath(r.file), "utf8").split("\n");
    const wantLo = lines !== undefined ? Math.max(lo, lines[0]) : lo;
    const wantHi = lines !== undefined ? Math.min(hi, lines[1]) : hi;
    return fileLines.slice(wantLo - 1, wantHi).join("\n");
  }

  /** Lazily parses the raw `.hbc` bytes once, shared by `ensureFrames` (CFG
   *  analysis) and `disasm` (raw instruction printing) — both are "live"
   *  verbs needing bytes that never land on disk in the artifact (§3.3). */
  private ensureModule(verb: string): HbcModule {
    if (this.hbcPath === undefined) {
      throw new Hbc2jsError(ErrorCode.E_USAGE, `query ${verb}: needs --hbc <input.hbc> (live verb, §3.3 — warm frames are not on disk)`);
    }
    if (this.hbcModule === undefined) {
      const bytes = readFileSync(this.hbcPath);
      this.hbcModule = parseHbc(bytes);
    }
    return this.hbcModule;
  }

  /** The module analysis alone (`src/cfg`'s block graphs), without the much
   *  more expensive `rawFrames` pass `ensureFrames` also runs. Memoised in
   *  the SAME `this.analysis` slot, so a caller that only wants a CFG
   *  (`functionCfg` below) and a later caller that wants frames share one
   *  `analyseModule` run — `warmAnalyseCount`'s "never more than 1" holds
   *  either way round. */
  private ensureAnalysis(verb: string): ModuleAnalysis {
    const module = this.ensureModule(verb);
    if (this.analysis === undefined) {
      this.analyseCount++;
      this.analysis = analyseModule(module, { strictEnv: true });
    }
    return this.analysis;
  }

  /** The live CFG of one function (docs/specs/03-cfg.md §3's `FunctionCfg`:
   *  blocks, normal edges, exception edges and regions) — a live verb like
   *  `disasm`/`list`, needing `--hbc`. `null` when this service has none, so
   *  a caller can DECLINE honestly (`src/ui-server/cfg.ts`) instead of
   *  drawing an empty graph. Throws the usual `E_USAGE` for an fn this
   *  artifact does not contain, exactly as `disasm` does. */
  functionCfg(fn: number): FunctionCfg | null {
    if (!this.hasFn(fn)) throw new Hbc2jsError(ErrorCode.E_USAGE, `query cfg: no such function ${fn} in this artifact`);
    if (this.hbcPath === undefined) return null;
    return this.ensureAnalysis("cfg").cfg(fn);
  }

  private ensureFrames(): { readonly analysis: ModuleAnalysis; readonly frames: Map<number, readonly import("../emit/ast.ts").Stmt[]> } {
    const analysis = this.ensureAnalysis("list/context");
    if (this.rawFrameMap === undefined) this.rawFrameMap = rawFrames(analysis);
    if (this.frames === undefined) {
      this.frames = new Map();
      for (const [fn, frame] of this.rawFrameMap) if (frame.node.k === "func") this.frames.set(fn, frame.node.body);
    }
    return { analysis, frames: this.frames };
  }

  /** Test-only: how many times `analyseModule` actually ran (never more than
   *  1 — see `analyseCount`'s own doc comment). */
  get warmAnalyseCount(): number {
    return this.analyseCount;
  }

  /** Proactively runs the whole-bundle live-frame computation
   *  (`analyseModule` + `rawFrames`, `ensureFrames` above) off a request's own
   *  critical path — on a large bundle (measured 65 s on Service NSW's 4,510
   *  modules / ~15k functions: `rawFrames` alone is ~90% of that) this is the
   *  same work the FIRST `/api/fn/{fn}/locals` or `/api/module/{id}/source`
   *  after start would otherwise pay for, synchronously, freezing every other
   *  route meanwhile. `src/ui-server/server.ts` calls this once, right after
   *  `listen`, so by the time a real request needs frames they are usually
   *  already there (docs/UI.md "Cold start").
   *
   *  No-op (resolves immediately) when this service has no `--hbc` (nothing
   *  live to warm) or the frames are already computed. Concurrent callers —
   *  the prewarm call racing an early request that reaches `ensureFrames`
   *  directly — share the SAME in-flight promise / the SAME memoised result:
   *  `ensureFrames`'s `this.analysis === undefined` guard is single-threaded
   *  JS, so only one real `analyseModule` pass ever runs regardless of how
   *  many callers ask (`warmAnalyseCount` above is the test-visible proof).
   *  The computation itself stays synchronous, on the main thread: it is
   *  wrapped in `setImmediate` only so the `listen` callback returns first,
   *  not to make it non-blocking (the `analysis` object closes over local
   *  helpers — `structuredClone` on it throws — so it cannot be handed to a
   *  `worker_threads` worker without a much larger refactor of `src/cfg`;
   *  out of scope here, logged clearly by the caller instead). */
  warmFrames(): Promise<void> {
    if (this.hbcPath === undefined) return Promise.resolve();
    if (this.analysis !== undefined && this.rawFrameMap !== undefined) return Promise.resolve();
    if (this.warmPromise === undefined) {
      this.warmPromise = new Promise<void>((resolve, reject) => {
        setImmediate(() => {
          this.warmPromise = undefined;
          try {
            this.ensureFrames();
            resolve();
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      });
    }
    return this.warmPromise;
  }

  /** Raw disassembly text for one function (`hbc2js disasm --function`,
   *  spec 02 §6.3) — a live verb like `list`/`context`, needing `--hbc`
   *  since raw bytecode text is never materialised in the artifact. Callers
   *  cap the returned lines themselves (mirrors `source()`, the other
   *  verb whose output is a whole text blob rather than a row set). */
  disasm(fn: number): string {
    if (!this.hasFn(fn)) throw new Hbc2jsError(ErrorCode.E_USAGE, `query disasm: no such function ${fn} in this artifact`);
    const module = this.ensureModule("disasm");
    const chunks: string[] = [];
    const out = { write: (chunk: string): boolean => (chunks.push(chunk), true) } as NodeJS.WritableStream;
    printModule(module, out, { mode: "raw", indices: [fn] });
    return chunks.join("");
  }

  /** The names an external store (the project DB) wants applied to `fn`'s
   *  registers — empty when nothing is injected or nothing is named. */
  private activeNamesFor(fn: number): ActiveNames {
    return this.activeNames?.(fn) ?? new Map();
  }

  /** Inject the accepted-name source for register bindings (`reg:F:R`).
   *  `ProjectService` wires this to `d_names` at construction, so every read
   *  path here (`source`, `renderFn`, `list`) shows accepted names without
   *  the caller knowing the storage layer. */
  setActiveNames(provider: (fn: number) => ActiveNames): void {
    this.activeNames = provider;
    this.renderCache.clear();
  }

  /** Drop the memoised per-function render — called after any name write
   *  (`ProjectService.setName`/`revertName`) so the next read re-renders. */
  invalidateRender(fn?: number): void {
    if (fn === undefined) this.renderCache.clear();
    else this.renderCache.delete(fn);
  }

  /** The stage-B pass options a per-function re-render must use to match the
   *  text `hbc2js render` wrote to disk. `src/split/index.ts` runs NO stage-B
   *  hook unless `--passes` was given, so an empty/absent recorded `passes`
   *  means "no stage-B passes" here too (docs/UI.md records the caveat). */
  private renderPassOpts(): PassPipelineOptions {
    const p = this.manifest.producer.passes;
    if (p !== null && typeof p === "object" && Object.keys(p as object).length > 0) return p as PassPipelineOptions;
    return { none: true };
  }

  /** True when the render this artifact's source was produced by runs
   *  `var-naming`, i.e. when its register idents are heuristic names rather
   *  than `rN`. Drives `list`'s `rendered` column. */
  private varNamingOn(): boolean {
    const opts = this.renderPassOpts();
    if (opts.none === true) return false;
    return enabledPasses({ ...opts, stage: "B" }).some((p) => p.name === "var-naming");
  }

  /** Re-render ONE function with the injected accepted names applied
   *  (`src/name-overlay/render.ts`'s `renderFrame`) — the per-request path the
   *  resident UI server uses instead of `render()`, which re-emits the whole
   *  module. `null` when this service has no `--hbc` (live-verb constraint) or
   *  the function has no emitted frame. Memoised per fn; `invalidateRender`
   *  clears it. */
  renderFn(fn: number): { readonly code: string; readonly collisions: readonly CollisionFlag[]; readonly lineMap: readonly LineMapEntry[] } | null {
    if (this.hbcPath === undefined) return null;
    const hit = this.renderCache.get(fn);
    if (hit !== undefined) return hit;
    const { analysis } = this.ensureFrames();
    const frame = this.rawFrameMap?.get(fn);
    if (frame === undefined) return null;
    if (this.astHook === undefined) this.astHook = astPassHook(analysis, this.renderPassOpts());
    const r = renderFrame(this.astHook, frame.node, frame.cfg, this.activeNamesFor(fn));
    const out = { code: r.code, collisions: r.collisions, lineMap: r.lineMap };
    this.renderCache.set(fn, out);
    return out;
  }

  /**
   * §16 source<->disasm alignment: which line of `source(fn)` came from which
   * instruction. `lines` is `[line, start, end]` with `line` 1-based inside the
   * FUNCTION's own text (what `source(fn)` returns with no `--lines`) and
   * `[start, end)` the function-relative byte range `disasm(fn)` prints as
   * `[@ start]`. `fnStartLine` is that text's first line in the module file, so
   * a caller showing the whole file can rebase.
   *
   * Honest-partial by construction (docs/specs/05-emitter.md §16): only
   * statements that kept a bytecode origin appear, and the map is built from
   * the SAME memoised render `source()` serves, so the numbers cannot drift.
   * Empty — never an error — when this service has no `--hbc` (the render is a
   * live verb) or the function has no emitted frame.
   */
  lineMap(fn: number): { readonly fn: number; readonly fnStartLine: number | null; readonly lines: readonly LineMapEntry[] } {
    if (!this.hasFn(fn)) throw new Hbc2jsError(ErrorCode.E_USAGE, `query linemap: no such function ${fn} in this artifact`);
    const fnStartLine = this.range(fn)?.lines[0] ?? null;
    const rendered = this.hbcPath === undefined ? null : this.renderFn(fn);
    return { fn, fnStartLine, lines: rendered?.lineMap ?? [] };
  }

  /** §3.1 `name list <fn>` (P2.1a(b)) — delegates to the shared live-frame
   *  query so the CLI's bare `hbc2js name list` (no artifact) and this
   *  service agree by construction. `rendered` joins on the served source:
   *  what the identifier for that register actually LOOKS like right now. */
  list(fn: number): readonly FrameNameableRegister[] {
    const { frames } = this.ensureFrames();
    const body = frames.get(fn);
    const rendered = body === undefined ? undefined : renderedRegisterNames(fn, body, this.activeNamesFor(fn), { varNaming: this.varNamingOn() });
    return listNameable(frames, fn, this.overlay, rendered);
  }

  /** §3.1 `name context <fn> <reg>` (P2.1a(b)/(c)). */
  context(fn: number, reg: number): readonly string[] {
    const { frames } = this.ensureFrames();
    return contextSites(frames, fn, reg);
  }
}

function sha256OfProducer(producer: Manifest["producer"]): string {
  // Mirrors `src/artifact/build.ts`'s `buildManifest` exactly (same input,
  // same hash function) — kept here rather than re-deriving it, so the
  // service stays a pure reader of the manifest's own recorded hash inputs.
  return sha256Hex(JSON.stringify(producer));
}
