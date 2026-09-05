// src/mcp/resources.ts — docs/specs/17-mcp-harness.md §1 (as revised §14):
// the READ resources of the MCP analysis surface. TRANSPORT-AGNOSTIC: this
// file has no MCP protocol/SDK binding (that is deferred, §6). It is a
// plain class, `McpResources`, over one already-open `ArtifactService` +
// `ProjectService` pair (spec 16 §3.2's warm services) — a thin typed
// re-projection of the shipped query layer, per the spec's own framing
// ("not a new store or a new set of answers").
//
// Every resource below is a "resolves to (verb)" row from §1's table: it
// calls the existing service method and reshapes the result, honoring that
// verb's OWN published cap (never a new one, per §1's own rule). Where the
// verb has no service method yet, that gap is called out in the resource's
// own doc comment rather than silently invented — see `packageId`, `log`,
// `history`, `annotatedCalls` below.
import type { DatabaseSync } from "node:sqlite";
import type { LineMapEntry } from "../emit/origin.ts";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ArtifactService, CAPS, type Bounded, type Edge, type FnSummary, type ObjectTablesOptions, type TemplateInjectionsOptions } from "../artifact/service.ts";
import { ProjectService, PROJECT_CAPS, type AnnotationRow } from "../project/service.ts";
import type { ResolvedFinding } from "../project/findings.ts";
import type { FindingStatus, Severity, Tag } from "../project/schema.ts";
import { hasProjectDb, openProjectDbReadonly } from "../projdb/artifact-read.ts";
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { computeLeads, searchFunctions, searchSource, LEADS_CAPS, type LeadsResult, type SearchPage, type FunctionMatch, type SourceMatch } from "./leads.ts";
import { buildInventory } from "../deps/inventory.ts";
import { resolveDbLayers, loadSignatures } from "../deps/db.ts";
import { deriveCandidatePackages } from "../deps/candidates.ts";
import { matchInventory, type MatchReport } from "../deps/match.ts";
import { guessModules, type ModuleGuess } from "../deps/guess.ts";
import { buildReport, type DepsReport } from "../deps/report.ts";
import { gateDependency, type IdentityBasis, type VersionBasis } from "../security/osv-gate.ts";
import { loadOsvSlice, matchOsv, type OsvMatch } from "../security/osv-adapter.ts";
import { SecretsService, type FindingRow as SecretFindingRow } from "../secrets/service.ts";

/** Light `{fn, name, size}` neighbour metadata inlined into every xref row
 *  (§14's "kill the N+1" fix — `who-calls` used to force ~12 follow-up
 *  `fn/{fn}` calls on NSW). `size` is the range's line count when the fn's
 *  range is known, else `null` (an out-of-scope/native/unresolved callee,
 *  same cases `Edge.file`/`Edge.line` are already `null` for). */
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
  /** Spec 17 §14.4: set only on an edge the `require(N)` points-to pass
   *  resolved; `exportName`/`module` say which module export the call went
   *  through. Absent on every edge that came straight from `calls.jsonl`. */
  readonly confidence?: "points-to";
  readonly exportName?: string;
  readonly module?: number;
}

/** One live `'suggested'`-tier name proposal (§15) — `ProjectService.
 *  listSuggestedNames`'s own row shape, re-exported here since it's what
 *  `fn`/`context` hand back. */
export interface SuggestedNameRow {
  readonly rid: string;
  readonly name: string;
  readonly who: string;
  readonly run?: string;
  readonly ts: string;
}

/** `FnSummary` (`ArtifactService`'s own `name`/`overlayName`) plus the
 *  `.hbcproj` name-slot fields §15 adds — see `withAnnotatedNames`'s doc
 *  comment for exactly what each one is and is not. */
export interface AnnotatedFnSummary extends FnSummary {
  readonly acceptedName?: string;
  readonly suggestedNames?: readonly SuggestedNameRow[];
}

const SOURCE_LINE_CAP = 400; // fn's own range in practice never exceeds this on real fixtures; see `source`/`disasm` doc comments.

function truncateLines(text: string, cap: number): { readonly text: string; readonly totalLines: number; readonly truncated: boolean } {
  const lines = text.split("\n");
  const truncated = lines.length > cap;
  return { text: truncated ? lines.slice(0, cap).join("\n") : text, totalLines: lines.length, truncated };
}

export interface McpResourcesOpts {
  readonly hbc?: string;
  readonly overlayStorePath?: string;
}

/** The transport-agnostic business-logic core of spec 17's MCP surface —
 *  READ resources only, this pass (spec 17 §6 defers the write tools, the
 *  lead-generators, `recompile_edit`/`generate_documentation`). One
 *  instance is scoped to one project directory, sharing the warm
 *  `ArtifactService`/`ProjectService` pair exactly as the CLI does (spec 16
 *  §3.2). */
export class McpResources {
  readonly artifact: ArtifactService;
  readonly project: ProjectService;
  private readonly artifactDir: string;
  private readonly hbcPath: string | undefined;
  private depsCache: Promise<{ readonly report: DepsReport; readonly matchReport: MatchReport; readonly guesses: readonly ModuleGuess[] } | null> | undefined;

  /** `services`: internal-only injection point for `src/mcp/context.ts`'s
   *  `McpContext` (docs/specs/17-mcp-harness.md §15's "shared service
   *  context" round) — when given, `artifact`/`project` are THOSE
   *  instances (the ones `McpContext.tools` also holds), never a fresh
   *  pair, which is what makes a `McpTools` write visible to THIS
   *  `McpResources` without rebuilding it. Every existing 2-arg call
   *  (`new McpResources(artifactDir, opts)`) is unaffected — this
   *  parameter is additive and optional. */
  constructor(artifactDir: string, opts: McpResourcesOpts = {}, services?: { readonly artifact: ArtifactService; readonly project: ProjectService }) {
    this.artifactDir = artifactDir;
    this.hbcPath = opts.hbc;
    this.artifact = services?.artifact ?? new ArtifactService(artifactDir, opts);
    this.project = services?.project ?? new ProjectService(artifactDir, this.artifact);
  }

  /** docs/specs/17-mcp-harness.md §15: `fn`/`context`'s own `metadata` never
   *  read the `.hbcproj` "name slot" (`d_names`/`dbGetName`) at all before
   *  this round — only `ArtifactService.fn()`'s own `name`/`overlayName`
   *  (the compiled name and the SEPARATE Design-D name-overlay store, out
   *  of this file's ownership). This adds the DB-backed accepted name and
   *  the live suggestions ADDITIVELY, as their own fields, alongside those
   *  — never replacing `name`/`overlayName` (that merge is a follow-up for
   *  whichever surface owns "the one name a reader sees", out of scope
   *  here). `acceptedName`/`suggestedNames` are `undefined` for a
   *  JSONL-backed project (`getName`/`listSuggestedNames`'s own `null`/`[]`
   *  scope gap, `ProjectService`'s doc comments). */
  private withAnnotatedNames(fn: number, s: FnSummary): AnnotatedFnSummary {
    const target = `fn:${fn}`;
    const accepted = this.project.getName(target);
    const suggested = this.project.listSuggestedNames(target);
    return {
      ...s,
      ...(accepted !== null ? { acceptedName: accepted.name } : {}),
      ...(suggested.length > 0 ? { suggestedNames: suggested } : {}),
    };
  }

  private neighbor(fnRef: number | string): NeighborRef {
    if (typeof fnRef !== "number") return { fn: fnRef, name: null, size: null };
    if (!this.artifact.hasFn(fnRef)) return { fn: fnRef, name: null, size: null };
    const s = this.artifact.fn(fnRef);
    const size = s.lines !== null ? s.lines[1] - s.lines[0] + 1 : null;
    return { fn: fnRef, name: s.overlayName ?? s.name, size };
  }

  private inlineEdges(bounded: Bounded<Edge>): Bounded<XrefEdge> {
    return {
      ...bounded,
      rows: bounded.rows.map((e) => ({
        ...this.neighbor(e.fn),
        file: e.file,
        line: e.line,
        kind: e.kind,
        ...(e.why !== undefined ? { why: e.why } : {}),
        ...(e.confidence !== undefined ? { confidence: e.confidence, exportName: e.exportName, module: e.module } : {}),
      })),
    };
  }

  // -- fn / source / context (§1, §14) -----------------------------------

  /** `fn/{fn}` — minimal preset: `query fn`'s own ≤ 10 lines, plus §15's
   *  `acceptedName`/`suggestedNames` (`withAnnotatedNames`). */
  fn(fn: number): AnnotatedFnSummary {
    return this.withAnnotatedNames(fn, this.artifact.fn(fn));
  }

  /** `source/{fn}` — rendered source, clipped to the fn's own range (spec
   *  10 §3.1's `query source`) — the ONLY resource besides `context`
   *  (below, when `source` is included) that emits source text, so no
   *  resource ever double-fetches it (§14's own requirement). */
  source(fn: number, opts: { readonly lines?: readonly [number, number] } = {}): { readonly text: string; readonly totalLines: number; readonly truncated: boolean } {
    const text = this.artifact.source(fn, opts.lines);
    return truncateLines(text, SOURCE_LINE_CAP);
  }

  /** `fn/{fn}/locals` — the nameable register bindings of one function
   *  (`ArtifactService.list`, spec 10 §3.1 `name list`) joined with the
   *  project's ACCEPTED name for each `reg:F:R` target. This is the map the
   *  UI needs to turn a clicked identifier in the source pane into the
   *  rename target `reg:F:R`: `rendered` is the identifier as it appears in
   *  the served source, `named` the accepted name (null when never named).
   *  Requires `--hbc` (live verb, same constraint as `source`'s siblings). */
  locals(fn: number): {
    readonly rows: readonly { readonly reg: number; readonly rendered: string; readonly named: string | null; readonly role: string; readonly uses: number }[];
    readonly total: number;
  } {
    const rows = this.artifact.list(fn).map((r) => ({
      reg: r.reg,
      rendered: r.rendered,
      named: this.project.getName(`reg:${fn}:${r.reg}`)?.name ?? r.named,
      role: r.role,
      uses: r.uses,
    }));
    return { rows, total: rows.length };
  }

  /** `disasm/{fn}` — raw disassembly text for one fn (spec 02 §6.3's
   *  `hbc2js disasm --function`), capped identically to `source` (task
   *  brief: "capped like source"). Requires `--hbc` at construction, same
   *  live-verb constraint as `source`'s CFG-derived siblings. */
  disasm(fn: number): { readonly text: string; readonly totalLines: number; readonly truncated: boolean } {
    const text = this.artifact.disasm(fn);
    return truncateLines(text, SOURCE_LINE_CAP);
  }

  /** `linemap/{fn}` — which line of `source/{fn}` came from which instruction
   *  (docs/specs/05-emitter.md §16). Uncapped: one small tuple per mapped
   *  line, and a partial map would be a *wrong* map for the lines it dropped,
   *  which the artifact truth rule forbids. Never throws for a missing render
   *  (no `--hbc`, no emitted frame) — `lines: []` is the honest answer. */
  lineMap(fn: number): { readonly fn: number; readonly fnStartLine: number | null; readonly lines: readonly LineMapEntry[] } {
    return this.artifact.lineMap(fn);
  }

  /** `context/{fn}` — the scoped analysis slice (§1/§14): a COMPOSITION of
   *  `fn` + `who-calls` + `calls-from` + strings-used, gated by `include`
   *  (default: all five per §1's original description minus the
   *  double-fetch rule) and `depth` (default 1 = direct neighbours only;
   *  `depth > 1` walks callers/callees that many hops, still applying each
   *  hop's own cap and de-duplicating — never a new answer, just more of
   *  the same bounded ones). Truncation is reported per component, per the
   *  spec's "union of the component caps; truncation marked per component". */
  context(
    fn: number,
    opts: { readonly include?: readonly ("metadata" | "source" | "callers" | "callees" | "strings")[]; readonly depth?: number } = {},
  ): {
    readonly fn: number;
    readonly metadata?: AnnotatedFnSummary;
    readonly source?: { readonly text: string; readonly totalLines: number; readonly truncated: boolean };
    readonly callers?: Bounded<XrefEdge>;
    readonly callees?: Bounded<XrefEdge>;
    readonly strings?: Bounded<{ readonly sid: number; readonly head: string; readonly role: string; readonly n: number }>;
  } {
    const include = new Set(opts.include ?? ["metadata", "source", "callers", "callees", "strings"]);
    const depth = Math.max(1, opts.depth ?? 1);
    const out: {
      fn: number;
      metadata?: AnnotatedFnSummary;
      source?: { text: string; totalLines: number; truncated: boolean };
      callers?: Bounded<XrefEdge>;
      callees?: Bounded<XrefEdge>;
      strings?: Bounded<{ sid: number; head: string; role: string; n: number }>;
    } = { fn };
    if (include.has("metadata")) out.metadata = this.withAnnotatedNames(fn, this.artifact.fn(fn));
    if (include.has("source")) out.source = this.source(fn) as { text: string; totalLines: number; truncated: boolean };
    if (include.has("callers")) out.callers = this.walkEdges(fn, "callers", depth) as Bounded<XrefEdge>;
    if (include.has("callees")) out.callees = this.walkEdges(fn, "callees", depth) as Bounded<XrefEdge>;
    if (include.has("strings")) out.strings = this.artifact.stringsUsedBy(fn) as Bounded<{ sid: number; head: string; role: string; n: number }>;
    return out;
  }

  /** Direct-neighbour edges at depth 1; `depth > 1` BFS-walks further hops,
   *  merging into one deduplicated (by fn) bounded set, each hop applying
   *  its own verb cap (`who-calls`/`calls-from`'s existing ≤ 50). */
  private walkEdges(fn: number, dir: "callers" | "callees", depth: number): Bounded<XrefEdge> {
    const seen = new Set<number>([fn]);
    const acc: XrefEdge[] = [];
    let total = 0;
    let truncated = false;
    let frontier = [fn];
    for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
      const next: number[] = [];
      for (const f of frontier) {
        const bounded = dir === "callers" ? this.artifact.whoCalls(f) : this.artifact.callsFrom(f);
        const edges = this.inlineEdges(bounded);
        total += edges.total;
        truncated = truncated || edges.truncated;
        for (const e of edges.rows) {
          if (typeof e.fn === "number") {
            if (!seen.has(e.fn)) {
              seen.add(e.fn);
              next.push(e.fn);
              acc.push(e);
            }
          } else {
            acc.push(e);
          }
        }
      }
      frontier = next;
    }
    return { rows: acc, total, truncated };
  }

  // -- xref (§1, §14) ------------------------------------------------------

  /** `xref/who-calls/{fn}` — spec-10 `query who-calls`'s own ≤ 50 + total,
   *  each row's `{fn, name, size}` inlined per §14. */
  whoCalls(fn: number, opts: { readonly all?: boolean } = {}): Bounded<XrefEdge> & { readonly unknownInScope: number } {
    const bounded = this.artifact.whoCalls(fn, opts);
    return { ...this.inlineEdges(bounded), unknownInScope: bounded.unknownInScope };
  }

  /** `xref/calls-from/{fn}` — spec-10 `query calls-from`'s own ≤ 50 + total. */
  callsFrom(fn: number, opts: { readonly all?: boolean } = {}): Bounded<XrefEdge> {
    return this.inlineEdges(this.artifact.callsFrom(fn, opts));
  }

  /** `xref/who-calls-by-name` (spec-17 §14) — NAME-based caller recovery for
   *  the `<slot>.export(...)` dispatch `who-calls` returns `total:0` for. Each
   *  candidate row carries `confidence:"by-name"` (never a resolved edge) and
   *  is inlined with the caller's `{name,size}` like the resolved xrefs. */
  whoCallsByName(target: { readonly fn: number } | { readonly name: string }, opts: { readonly all?: boolean } = {}) {
    const r = this.artifact.whoCallsByName(target, opts);
    return {
      ...r,
      rows: r.rows.map((row) => {
        const nb = this.neighbor(row.fn);
        return { fn: row.fn, callerName: nb.name, size: nb.size, name: row.name, role: row.role, n: row.n, file: row.file, line: row.line, confidence: row.confidence };
      }),
    };
  }

  /** `object-tables` (spec 17 §14.2) — bundle-wide inventory of constant
   *  object literals, the one-shot "show me every endpoint table" the hunt
   *  wanted (docs/specs/hunt-tooling-backlog.md). Rows are inlined with the
   *  CONTAINING function's name/size (`fnName`/`size`) the same way the xref
   *  rows are; `name` is deliberately not reused here because a table row's
   *  interesting names are its member keys. */
  objectTables(opts: ObjectTablesOptions = {}) {
    const r = this.artifact.objectTables(opts);
    return {
      ...r,
      tables: r.tables.map((t) => {
        const nb = this.neighbor(t.fn);
        return { ...t, fnName: nb.name, size: nb.size };
      }),
    };
  }

  /** `template-injections` (spec 17 §14.3) — the WebView-injection
   *  anti-pattern lead (hunt lead C1, docs/specs/hunt-tooling-backlog.md
   *  line ~55): a template literal / `+` chain whose static text quotes a
   *  substitution. Rows are inlined with the CONTAINING function's
   *  `fnName`/`size`, same convention as `objectTables`. */
  templateInjections(opts: TemplateInjectionsOptions = {}) {
    const r = this.artifact.templateInjections(opts);
    return {
      ...r,
      rows: r.rows.map((row) => {
        const nb = this.neighbor(row.fn);
        return { ...row, fnName: nb.name, size: nb.size };
      }),
    };
  }

  /** `string-uses` (spec 17 mirror of spec 10 §3.1 `query string-uses`,
   *  hunt-tooling-backlog gap #2) — instruction-level use SITES for a sid,
   *  computed on demand (never stored on disk — spec 10 §2.3b keeps
   *  `string-uses.jsonl` at `(sid, fn, role) -> n`). Rows already carry
   *  `fnName` from the service; inlined with the containing function's
   *  `size` too, same convention as `objectTables`/`templateInjections`. */
  stringUseSites(sid: number, opts: { readonly fn?: number; readonly all?: boolean } = {}) {
    const r = this.artifact.stringUseSites(sid, opts);
    return {
      ...r,
      rows: r.rows.map((row) => ({ ...row, size: this.neighbor(row.fn).size })),
    };
  }

  /** `xref/string` — merges the two pre-§14 string endpoints (spec 10
   *  `query string`/`query string-grep`) behind one `mode`: `exact` reads a
   *  single sid (`key` must be a number); `substring`/`regex` grep every
   *  string's head/value (`key` a pattern string — `substring` is escaped
   *  into a literal regex before reaching `stringGrep`, `regex` passed
   *  through as-is), each mode keeping its own verb's cap. `exact`'s `uses`
   *  rows are inlined with `{name,size}` the same way `inlineEdges` inlines
   *  `who-calls`/`calls-from` (docs/UI.md "Strings & globals (xref)" gap,
   *  additive fields only — `StringUseSite`'s `fn`/`role`/`n` unchanged). */
  xrefString(
    key: number | string,
    mode: "exact" | "substring" | "regex" = "exact",
  ): { readonly value: unknown; readonly uses: Bounded<unknown> } | Bounded<{ readonly sid: number; readonly head: string; readonly uses: number }> {
    if (mode === "exact") {
      if (typeof key !== "number") throw new Hbc2jsError(ErrorCode.E_USAGE, "xref/string: mode=exact needs a numeric sid");
      const r = this.artifact.string(key);
      return {
        value: r.value,
        uses: { ...r.uses, rows: r.uses.rows.map((row) => ({ ...row, ...this.neighbor(row.fn) })) },
      };
    }
    if (typeof key !== "string") throw new Hbc2jsError(ErrorCode.E_USAGE, `xref/string: mode=${mode} needs a string pattern`);
    const pattern = mode === "substring" ? key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : key;
    return this.artifact.stringGrep(pattern);
  }

  /** `xref/global-uses/{name}` — spec-10 `query global-uses`'s own ≤ 50 +
   *  total, rows inlined with `{name,size}` like `xrefString`'s `exact`
   *  uses (docs/UI.md "Strings & globals (xref)" gap). */
  globalUses(name: string, opts: { readonly all?: boolean } = {}) {
    const r = this.artifact.globalUses(name, opts);
    return { ...r, rows: r.rows.map((row) => ({ ...row, ...this.neighbor(row.fn) })) };
  }

  // -- module / package-id / native (§1, §14) ------------------------------

  /** `module/{mod}` — module + DIRECT edges only (§14 cut `module-graph`'s
   *  whole-graph read; the analyst walks it one `module/{mod}` at a time). */
  module(id: number) {
    return this.artifact.module(id);
  }

  /** Lazily builds the module inventory + match/guess stages (`src/deps`)
   *  from the `--hbc` bundle this instance was constructed with, cached for
   *  the instance's lifetime (parsing the bundle + scoring every signature
   *  DB entry is expensive; `package-id`/`scan/deps` both need the same
   *  `DepsReport` and must never redo it per call). `offline: true`
   *  unconditionally — an MCP READ resource must never make an outbound
   *  network call (no `npm` search, no confirm stage); a caller who wants
   *  the deeper `--confirm` identification still has the `hbc2js deps`
   *  CLI. Returns `null` when this instance has no `--hbc` bundle
   *  configured (the identification needs the module inventory, which only
   *  the raw bytes carry — the derived artifact index does not). */
  private computeDeps(): Promise<{ readonly report: DepsReport; readonly matchReport: MatchReport; readonly guesses: readonly ModuleGuess[] } | null> {
    if (this.depsCache !== undefined) return this.depsCache;
    if (this.hbcPath === undefined) {
      this.depsCache = Promise.resolve(null);
      return this.depsCache;
    }
    const hbcPath = this.hbcPath;
    this.depsCache = (async () => {
      const bytes = readFileSync(hbcPath);
      const { inventory } = buildInventory(bytes);
      const layers = resolveDbLayers({ outDir: this.artifactDir });
      const dbs = loadSignatures(layers, { candidates: deriveCandidatePackages(layers, inventory) });
      const matchReport = matchInventory(inventory, dbs);
      const knownPackages = new Set(dbs.map((d) => d.file.package));
      const guesses = await guessModules(inventory, matchReport, { offline: true, knownPackages });
      const report = buildReport(hbcPath, matchReport, guesses, [], null);
      return { report, matchReport, guesses };
    })();
    return this.depsCache;
  }

  /** Public half of `computeDeps()`: the `DepsReport` alone, for callers
   *  outside this class that need `segregateSplitTree`'s `deps` parameter
   *  (`src/ui-server/segregation.ts`'s async deps recompute) without a
   *  second independent `deps` run — same cached promise `packageId`/
   *  `scanDeps` share. `null` exactly when `computeDeps()` is (no `--hbc`
   *  bundle configured for this instance). Measured 16.5 s on Service NSW
   *  (4,510 modules, offline signature-DB match + guess, no network) — see
   *  `docs/UI.md`'s route table row for `/api/segregation`. */
  async depsReport(): Promise<DepsReport | null> {
    const computed = await this.computeDeps();
    return computed?.report ?? null;
  }

  /** `package-id/{mod}` — spec-13's reuse-validation two-key gate (`src/
   *  security/osv-gate.ts`'s `gateDependency`) over the module the shared
   *  signature DB (spec 15) attributes `mod` to. Every row cites the sigdb
   *  match/guess that produced it (§1's "never a guess") — a module with no
   *  attribution, or whose only lead fails the two-key gate (no identity,
   *  or identity but no direct version), comes back `available: false`
   *  with a reason, not a fabricated identification. */
  async packageId(mod: number): Promise<PackageIdResult> {
    const computed = await this.computeDeps();
    if (computed === null) {
      return { available: false, mod, reason: "package-id: no --hbc bundle configured for this project (module-inventory identification needs the raw bytes)" };
    }
    const { report, matchReport, guesses } = computed;
    const attribution = [...matchReport.moduleAttributions, ...matchReport.unattributedModules].find((a) => a.localModuleId === mod);
    const guess = guesses.find((g) => g.localModuleId === mod);
    const pkgName = attribution?.owners[0] ?? guess?.candidates[0]?.package;
    if (pkgName === undefined) {
      return { available: false, mod, reason: `package-id: module ${mod} has no signature-DB match and no guess evidence` };
    }
    const gate = gateDependency(report, pkgName);
    if (!gate.hasIdentity) {
      return { available: false, mod, reason: `package-id: candidate package "${pkgName}" for module ${mod} did not clear the identification gate (spec 13 two-key)` };
    }
    return {
      available: true,
      mod,
      package: gate.package,
      version: gate.version,
      tier: gate.tier as "claim" | "candidate",
      identityBasis: gate.identityBasis,
      versionBasis: gate.versionBasis,
      evidence: `mod:${mod}`,
    };
  }

  /** `native[/{fn}]` — spec-10 `query native`'s own ≤ 50 + total. */
  native(opts: { readonly fn?: number; readonly all?: boolean } = {}) {
    return this.artifact.native(opts);
  }

  // -- spec 27 §L5 -- native-side (APK) read verbs -------------------------
  // A THIN re-projection of `ArtifactService`'s own §L5 methods, same idiom
  // as every resource above (this class never re-derives a native fact).
  // `native/` is optional-by-construction: every method below answers
  // empty/null rather than throwing when this artifact ingested no native
  // side, so an agent loop can always call these speculatively.

  /** `native/modules` — spec 27 §L5, `ArtifactService.nativeModules()`'s own
   *  cap (100 rows/call). */
  nativeModules(opts: { readonly all?: boolean } = {}) {
    return this.artifact.nativeModules(opts);
  }

  /** `native/module/{x}` — one module (by `jsName`, or its raw key), its
   *  methods, and every seam that names it, in one call — the seam is a
   *  first-class read object so an agent can pull "the native impl of this
   *  JS call" in one cheap hop (spec 27 §L5's own framing). `null` when no
   *  such module exists in this artifact. */
  nativeModule(x: string) {
    return this.artifact.nativeModule(x);
  }

  /** `native/seams` — spec 27 §L5, `ArtifactService.seams()`'s own cap (100
   *  rows/call). A seam is a first-class read object: `status:"linked"`
   *  cites both a JS call site and a native module/method, `"js-only"`/
   *  `"native-only"` cite one side and `null` the other — never a guess. */
  seams(filter: { readonly status?: "linked" | "js-only" | "native-only"; readonly firstParty?: boolean; readonly all?: boolean } = {}) {
    return this.artifact.seams(filter);
  }

  /** `native/manifest` — the AXML-derived package/permissions/components
   *  block (`native/manifest.json`, spec 27 §L1). `null` when no native
   *  side was ingested. Small and singular: never paginated. */
  nativeManifest() {
    return this.artifact.nativeManifest();
  }

  /** `native/resources` — `native/resources.jsonl` rows whose key matches
   *  `pattern` (`ArtifactService.nativeResources()`'s own cap, 50/call). */
  nativeResources(pattern: string, opts: { readonly all?: boolean } = {}) {
    return this.artifact.nativeResources(pattern, opts);
  }

  /** The Context-pane native-impl link (spec 27 §L5): every seam whose JS
   *  evidence cites `fn` as a call site, paired with its native module row
   *  when linked. Empty when `fn` participates in no seam. */
  nativeImplFor(fn: number) {
    return this.artifact.nativeImplFor(fn);
  }

  // -- leads / search (§14 additions 1 + 3) --------------------------------

  /** `leads` / `security-sinks` — spec 17 §14 addition 1: every security-
   *  decision call site the artifact already knows about (native surface +
   *  string xrefs + global reads), grouped by class. See `src/mcp/
   *  leads.ts`'s `computeLeads` for the derivation. */
  leads(): LeadsResult {
    return computeLeads(this.artifact);
  }

  /** Alias — §14 names this resource both ways (`leads` / `security-
   *  sinks`); same answer, same cap. */
  securitySinks(): LeadsResult {
    return this.leads();
  }

  /** `search/functions` — name substring/regex search over every function,
   *  paginated (§14 addition 3, the typed replacement for the cut
   *  `query`). */
  searchFunctions(query: string, opts: { readonly regex?: boolean; readonly cursor?: number } = {}): SearchPage<FunctionMatch> {
    return searchFunctions(this.artifact, query, opts);
  }

  /** `search/source` — bounded grep over rendered source, paginated (§14
   *  addition 3). */
  searchSource(query: string, opts: { readonly regex?: boolean; readonly cursor?: number } = {}): SearchPage<SourceMatch> {
    return searchSource(this.artifact, query, opts);
  }

  // -- scan/{secrets|deps|semgrep} (§14 addition 2) ------------------------

  /** `scan/secrets` — runs the existing secrets scanner (`src/secrets/
   *  service.ts`, the same idempotent R3-slotted pass the `secrets scan`
   *  CLI verb runs) and returns its capped findings. Idempotent: re-scanning
   *  an unchanged bundle writes nothing new (§6 of that module's own
   *  header) — this is the SAME write path the CLI already ships and
   *  tests, called here rather than reinvented, per §14 addition 2 ("the
   *  cheap lead generators, callable"). Honest `available: false` (not a
   *  crash) when the project is `.hbcproj`-backed: `SecretsService` reads
   *  `index/strings.json`/`string-uses.jsonl` off disk directly and does
   *  not yet know about the DB stratum (docs/BUGS.md — filed alongside this
   *  change, not silently swallowed). */
  scanSecrets(): (Bounded<SecretFindingRow> & { readonly available: true }) | { readonly available: false; readonly reason: string; readonly rows: readonly SecretFindingRow[]; readonly total: 0; readonly truncated: false } {
    if (!existsSync(join(this.artifactDir, "index", "strings.json"))) {
      return { available: false, reason: "scan/secrets: this project is .hbcproj-backed; src/secrets/service.ts reads index/*.jsonl directly and does not yet support DB-backed artifacts (docs/BUGS.md)", rows: [], total: 0, truncated: false };
    }
    const svc = new SecretsService({ artifactDir: this.artifactDir });
    svc.scan();
    const rows = svc.list();
    const cap = CAPS_SCAN_SECRETS;
    return { available: true, rows: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
  }

  /** `scan/deps` — OSV advisory matches for this bundle's identified
   *  dependencies (`src/security/osv-adapter.ts`'s pure `matchOsv`, against
   *  the committed offline slice — no network). Unlike `scan/secrets`,
   *  read-only: it does NOT write findings (that would need a `DepsReport`-
   *  specific `reportHash`/`runId` this read path has no reason to mint) —
   *  a caller who wants the match recorded runs `tools/security/measure-
   *  osv.ts` (or a future `record_finding` off this same evidence). */
  async scanDeps(): Promise<Bounded<OsvMatch> & { readonly available: boolean; readonly reason?: string }> {
    const computed = await this.computeDeps();
    if (computed === null) {
      return { available: false, reason: "scan/deps: no --hbc bundle configured for this project", rows: [], total: 0, truncated: false };
    }
    const slice = loadOsvSlice();
    const matches = matchOsv(computed.report, slice);
    const cap = CAPS_SCAN_DEPS;
    return { available: true, rows: matches.slice(0, cap), total: matches.length, truncated: matches.length > cap };
  }

  /** `scan/semgrep` — Lane S (semgrep-based static rules) is not built in
   *  this codebase yet. Honest stub, not a fabricated empty result — same
   *  discipline `package-id` used to follow before this task wired it up. */
  scanSemgrep(): { readonly available: false; readonly reason: string } {
    return { available: false, reason: "Lane S not built" };
  }

  // -- annotations / findings (§1) -----------------------------------------

  /** `annotations/for-fn/{fn}` — spec-11 `project for-fn`'s own ≤ 40 + total. */
  annotationsForFn(fn: number, opts: { readonly all?: boolean } = {}): Bounded<AnnotationRow> {
    return this.project.forFn(fn, opts);
  }

  /** `findings[?tag&severity&status]` — spec-11 `project findings`'s own ≤ 50 + total. */
  findings(
    query: { readonly tag?: Tag; readonly severity?: Severity; readonly status?: FindingStatus } = {},
    opts: { readonly all?: boolean } = {},
  ): Bounded<ResolvedFinding> {
    return this.project.findings(query, opts);
  }

  /** `finding/{id}` — spec-11 `project finding show`'s own ≤ 20 lines. */
  finding(rid: string): ResolvedFinding | null {
    return this.project.finding(rid);
  }

  // -- log / history / annotated-calls (spec 16 §3.2) ----------------------
  //
  // None of these three have a `ProjectService`/`ArtifactService` method
  // yet: §3.2's `log`/`history`/`annotated-calls` are new DB-native verbs
  // this spec's own reading list cites, but `ProjectService` only ever
  // loads annotation records into an in-memory `ProjectStore` (see
  // `src/projdb/project-read.ts`'s header note: it does not carry the `log`
  // table at all) and keeps no open DB handle to query after construction.
  // Rather than invent a wrapper class this pass is not scoped to build,
  // these three read the readonly `.hbcproj` connection directly against
  // the exact tables/shapes spec 16 §2.2/§3.2 publish, with the same
  // `LIMIT cap+1` truncation discipline as every other verb here. This is a
  // known scope gap (not a bug): a follow-up should promote this into
  // proper `ProjectService` methods so the CLI's own `project log`/
  // `project history` verbs (also unimplemented) share the same code.

  private openDb(): DatabaseSync {
    if (!hasProjectDb(this.artifactDir)) {
      throw new Hbc2jsError(ErrorCode.E_USAGE, "log/history/annotated-calls: this project has no project.hbcproj (JSONL-backed projects do not carry a change log, spec 16 §2.2)");
    }
    return openProjectDbReadonly(this.artifactDir);
  }

  /** `log[?since&who]` — spec 16 §3.2, ≤ 50 lines + total, one row per
   *  `log` table entry (§2.2), newest first. */
  log(query: { readonly since?: string; readonly who?: string } = {}, opts: { readonly all?: boolean } = {}): Bounded<{
    readonly seq: number;
    readonly ts: string;
    readonly who: string;
    readonly op: string;
    readonly detail: string | null;
  }> {
    const db = this.openDb();
    try {
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (query.since !== undefined) {
        clauses.push("ts >= ?");
        params.push(query.since);
      }
      if (query.who !== undefined) {
        clauses.push("actor_who = ?");
        params.push(query.who);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM log ${where}`).get(...params) as { n: number }).n;
      const cap = opts.all === true ? total : CAPS_LOG;
      const rows = db
        .prepare(`SELECT seq, ts, actor_who AS who, op, detail FROM log ${where} ORDER BY seq DESC LIMIT ?`)
        .all(...params, cap + 1) as unknown as { seq: number; ts: string; who: string; op: string; detail: string | null }[];
      return { rows: rows.slice(0, cap), total, truncated: rows.length > cap };
    } finally {
      db.close();
    }
  }

  /** `history/{target}` — spec 16 §3.2, ≤ 40 lines + total: the full
   *  `revisions` supersession/revert timeline for one binding-id target,
   *  newest first. */
  history(target: string, opts: { readonly all?: boolean } = {}): Bounded<{
    readonly rid: number;
    readonly kind: string;
    readonly ts: string;
    readonly supersedes: number | null;
    readonly reactivates: number | null;
    readonly cleared: boolean;
    readonly who: string;
  }> {
    const db = this.openDb();
    try {
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE target = ?`).get(target) as { n: number }).n;
      const cap = opts.all === true ? total : CAPS_HISTORY;
      const rows = db
        .prepare(
          `SELECT rid, kind, ts, supersedes, reactivates, cleared, prov_who AS who FROM revisions
             WHERE target = ? ORDER BY rid DESC LIMIT ?`,
        )
        .all(target, cap + 1) as unknown as { rid: number; kind: string; ts: string; supersedes: number | null; reactivates: number | null; cleared: number; who: string }[];
      return { rows: rows.slice(0, cap).map((r) => ({ ...r, cleared: r.cleared !== 0 })), total, truncated: rows.length > cap };
    } finally {
      db.close();
    }
  }

  /** `annotated-calls[?tag&status]` — spec 16 §3.2's cross-store join: one
   *  row per caller edge into a fn holding a matching active FINDING
   *  (scope note: standalone tags with no finding are not walked this pass
   *  — `project.findings()` is the filter this composes, per its own
   *  `tag`/`status` params; a future pass can widen this to plain tags).
   *  Built from already-loaded `ProjectService`/`ArtifactService` state
   *  (no raw SQL needed here, unlike `log`/`history` above), so it works
   *  for both JSONL- and DB-backed projects alike. */
  annotatedCalls(
    query: { readonly tag?: Tag; readonly status?: FindingStatus } = {},
    opts: { readonly all?: boolean } = {},
  ): Bounded<{ readonly caller: XrefEdge; readonly calleeFn: number; readonly finding: { readonly rid: string; readonly severity: string; readonly status: string } }> {
    const findings = this.project.findings(query, { all: true }).rows;
    const targetFns = new Map<number, ResolvedFinding[]>();
    for (const f of findings) {
      const m = /^fn:(\d+)$/.exec(f.record.target);
      if (m === null) continue;
      const fn = Number(m[1]);
      const list = targetFns.get(fn) ?? [];
      list.push(f);
      targetFns.set(fn, list);
    }
    const rows: { caller: XrefEdge; calleeFn: number; finding: { rid: string; severity: string; status: string } }[] = [];
    for (const [calleeFn, fs] of targetFns) {
      const callers = this.inlineEdges(this.artifact.whoCalls(calleeFn, { all: true }));
      for (const caller of callers.rows) {
        for (const f of fs) {
          rows.push({ caller, calleeFn, finding: { rid: f.record.rid, severity: f.record.severity, status: f.record.status } });
        }
      }
    }
    const cap = opts.all === true ? rows.length : CAPS_ANNOTATED_CALLS;
    return { rows: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
  }
}

const CAPS_LOG = 50;
const CAPS_HISTORY = 40;
const CAPS_ANNOTATED_CALLS = 50;
const CAPS_SCAN_SECRETS = 50;
const CAPS_SCAN_DEPS = 50;

/** `package-id/{mod}` result — spec-13's two-key gate output for one
 *  module, or an honest `available: false` (never a guess, §1's own
 *  wording). `tier`/`identityBasis`/`versionBasis` are `gateDependency`'s
 *  own vocabulary (`src/security/osv-gate.ts`) — re-exported here rather
 *  than restated. */
export type PackageIdResult =
  | { readonly available: false; readonly mod: number; readonly reason: string }
  | {
      readonly available: true;
      readonly mod: number;
      readonly package: string;
      readonly version: string | null;
      readonly tier: "claim" | "candidate";
      readonly identityBasis: IdentityBasis;
      readonly versionBasis: VersionBasis;
      readonly evidence: string;
    };

// Re-export the caps every resource above delegates to, so a test/consumer
// can assert against the SAME constant this file reads rather than a
// hand-copied number (kills a whole class of "cap drifted, test didn't"
// bugs at the source).
export const RESOURCE_CAPS = {
  ...CAPS,
  ...PROJECT_CAPS,
  log: CAPS_LOG,
  history: CAPS_HISTORY,
  annotatedCalls: CAPS_ANNOTATED_CALLS,
  sourceLines: SOURCE_LINE_CAP,
  scanSecrets: CAPS_SCAN_SECRETS,
  scanDeps: CAPS_SCAN_DEPS,
  ...LEADS_CAPS,
} as const;
