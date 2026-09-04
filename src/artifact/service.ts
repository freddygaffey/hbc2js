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
import type { ModuleAnalysis } from "../cfg/types.ts";
import { parseHbc } from "../parse/module.ts";
import type { HbcModule } from "../parse/types.ts";
import { rawFrames, type RawFrame } from "../name-overlay/frames.ts";
import { renderFrame, renderedRegisterNames, type ActiveNames, type CollisionFlag } from "../name-overlay/render.ts";
import { astPassHook, enabledPasses, type AstPassHook, type PassPipelineOptions } from "../passes/index.ts";
import { OverlayStore } from "../name-overlay/store.ts";
import { printModule } from "../disasm/print.ts";
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
  FunctionRow,
  GlobalRow,
  Manifest,
  ModulesIndex,
  NativeRow,
  RangeRow,
  StringRow,
  StringUseRow,
  StringsIndex,
} from "./schema.ts";

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
}

export interface Bounded<T> {
  readonly rows: readonly T[];
  readonly total: number;
  readonly truncated: boolean;
}

/** §3.1 output caps — the number of DATA rows a default (non `--all`/`--page`)
 *  call returns; the CLI appends the `total`/truncation line on top. */
export const CAPS = {
  whoCalls: 50,
  callsFrom: 50,
  string: 30,
  stringGrep: 50,
  globalUses: 50,
  native: 50,
} as const;

function fnDir(artifactDir: string): string {
  return join(artifactDir, "index");
}

export class ArtifactService {
  readonly manifest: Manifest;
  private readonly functionsByFn = new Map<number, FunctionRow>();
  private readonly callersByCallee = new Map<number, CallRow[]>();
  private readonly callsByCaller = new Map<number, CallRow[]>();
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
  private readonly renderCache = new Map<number, { readonly code: string; readonly collisions: readonly CollisionFlag[] }>();
  private hbcModule: HbcModule | undefined;
  private overlay: OverlayStore | undefined;

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

      this.populateFromRows({ functionRows, callRows, stringsIndex, stringUseRows, globalRows, nativeRows, modulesIndex, rangeRows });
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
  private populateFromRows(rows: DbIndexRows): void {
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

  /** §3.1 `query who-calls <fn>` — inverts calls.jsonl (§2.2's own note). */
  whoCalls(fn: number, opts: { readonly all?: boolean } = {}): Bounded<Edge> & { readonly unknownInScope: number } {
    const rows = this.callersByCallee.get(fn) ?? [];
    const edges = rows.map((c) => this.edgeFromCall({ ...c, callee: fn }, "caller"));
    const cap = opts.all === true ? edges.length : CAPS.whoCalls;
    return { rows: edges.slice(0, cap), total: edges.length, truncated: edges.length > cap, unknownInScope: this.totalUnknownCallees };
  }

  /** §3.1 `query calls-from <fn>`. */
  callsFrom(fn: number, opts: { readonly all?: boolean } = {}): Bounded<Edge> {
    const rows = this.callsByCaller.get(fn) ?? [];
    const edges = rows.map((c) => this.edgeFromCall(c, "callee"));
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

  /** §3.1 `query native [--fn N]`. */
  native(opts: { readonly fn?: number; readonly all?: boolean } = {}): Bounded<NativeRow> {
    const rows = opts.fn !== undefined ? this.nativeRows.filter((n) => n.fn === opts.fn) : this.nativeRows;
    const cap = opts.all === true ? rows.length : CAPS.native;
    return { rows: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
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

  private ensureFrames(): { readonly analysis: ModuleAnalysis; readonly frames: Map<number, readonly import("../emit/ast.ts").Stmt[]> } {
    const module = this.ensureModule("list/context");
    if (this.analysis === undefined) {
      this.analysis = analyseModule(module, { strictEnv: true });
    }
    if (this.rawFrameMap === undefined) this.rawFrameMap = rawFrames(this.analysis);
    if (this.frames === undefined) {
      this.frames = new Map();
      for (const [fn, frame] of this.rawFrameMap) if (frame.node.k === "func") this.frames.set(fn, frame.node.body);
    }
    return { analysis: this.analysis, frames: this.frames };
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
  renderFn(fn: number): { readonly code: string; readonly collisions: readonly CollisionFlag[] } | null {
    if (this.hbcPath === undefined) return null;
    const hit = this.renderCache.get(fn);
    if (hit !== undefined) return hit;
    const { analysis } = this.ensureFrames();
    const frame = this.rawFrameMap?.get(fn);
    if (frame === undefined) return null;
    if (this.astHook === undefined) this.astHook = astPassHook(analysis, this.renderPassOpts());
    const r = renderFrame(this.astHook, frame.node, frame.cfg, this.activeNamesFor(fn));
    const out = { code: r.code, collisions: r.collisions };
    this.renderCache.set(fn, out);
    return out;
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
