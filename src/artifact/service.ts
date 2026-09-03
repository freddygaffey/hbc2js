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
import { rawFrameBodies } from "../name-overlay/frames.ts";
import { OverlayStore } from "../name-overlay/store.ts";
import { listNameable, contextSites, type NameableRegister as FrameNameableRegister } from "./frame-queries.ts";
import { sha256Hex } from "./schema.ts";
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
  private readonly stringUses: readonly StringUseRow[];
  private readonly globals: readonly GlobalRow[];
  private readonly nativeRows: readonly NativeRow[];
  private readonly modulesIndex: ModulesIndex;
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
  private overlay: OverlayStore | undefined;

  constructor(artifactDir: string, opts: { readonly hbc?: string; readonly overlayStorePath?: string } = {}) {
    this.artifactDir = artifactDir;
    this.hbcPath = opts.hbc;
    const manifestPath = join(artifactDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Hbc2jsError(ErrorCode.E_IO, `${artifactDir} has no manifest.json — not an artifact (docs/specs/10-artifact-format.md §1.2)`);
    }
    this.manifest = readJson<Manifest>(manifestPath);

    const dir = fnDir(artifactDir);
    const { rows: functionRows } = readJsonlRows<FunctionRow>(join(dir, "functions.jsonl"));
    for (const r of functionRows) this.functionsByFn.set(r.fn, r);

    const { rows: callRows } = readJsonlRows<CallRow>(join(dir, "calls.jsonl"));
    for (const c of callRows) {
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

    const stringsIndex = readJson<StringsIndex>(join(dir, "strings.json"));
    for (const e of stringsIndex.entries) this.stringsById.set(e.sid, e);

    ({ rows: this.stringUses } = readJsonlRows<StringUseRow>(join(dir, "string-uses.jsonl")));
    ({ rows: this.globals } = readJsonlRows<GlobalRow>(join(dir, "globals.jsonl")));
    ({ rows: this.nativeRows } = readJsonlRows<NativeRow>(join(dir, "native.jsonl")));
    this.modulesIndex = readJson<ModulesIndex>(join(dir, "modules.json"));

    // §4.2 staleness: ranges header renderHash must equal manifest render.hash.
    const { header: rangesHeader, rows: rangeRows } = readJsonlRows<RangeRow>(join(dir, "ranges.jsonl"));
    if (rangesHeader.renderHash !== this.manifest.render.hash) {
      throw new Hbc2jsError(
        ErrorCode.E_STALE_RANGES,
        `${artifactDir}: ranges.jsonl renderHash (${rangesHeader.renderHash}) != manifest.render.hash (${this.manifest.render.hash}) — ` +
          `run \`hbc2js render\` to regenerate ranges before querying (docs/specs/10-artifact-format.md §4.2)`,
      );
    }
    for (const r of rangeRows) this.rangesByFn.set(r.fn, r);

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

  /** §3.1 `query module <id>`. */
  module(id: number): { readonly deps: readonly number[]; readonly dependents: readonly number[]; readonly ownedFnCount: number; readonly file: string | null } {
    const m = this.modulesIndex.modules.find((x) => x.id === id);
    const dependents = this.modulesIndex.modules.filter((x) => x.deps.includes(id)).map((x) => x.id);
    let ownedFnCount = 0;
    for (const owner of Object.values(this.modulesIndex.fnOwnership)) if (owner === id) ownedFnCount++;
    return { deps: m?.deps ?? [], dependents, ownedFnCount, file: m?.file ?? null };
  }

  /** §3.1 `query source <fn> [--lines a-b]` — the only source-emitting verb;
   *  clipped to the function's own range regardless of the requested slice. */
  source(fn: number, lines?: readonly [number, number]): string {
    const r = this.range(fn);
    if (r === undefined) throw new Hbc2jsError(ErrorCode.E_USAGE, `query source: no range recorded for fn ${fn}`);
    const filePath = join(this.artifactDir, r.file);
    const fileLines = readFileSync(filePath, "utf8").split("\n");
    const [lo, hi] = r.lines;
    const wantLo = lines !== undefined ? Math.max(lo, lines[0]) : lo;
    const wantHi = lines !== undefined ? Math.min(hi, lines[1]) : hi;
    return fileLines.slice(wantLo - 1, wantHi).join("\n");
  }

  private ensureFrames(): { readonly analysis: ModuleAnalysis; readonly frames: Map<number, readonly import("../emit/ast.ts").Stmt[]> } {
    if (this.hbcPath === undefined) {
      throw new Hbc2jsError(ErrorCode.E_USAGE, `query ${"list/context"}: needs --hbc <input.hbc> (live verb, §3.3 — warm frames are not on disk)`);
    }
    if (this.analysis === undefined) {
      const bytes = readFileSync(this.hbcPath);
      const module = parseHbc(bytes);
      this.analysis = analyseModule(module, { strictEnv: true });
    }
    if (this.frames === undefined) this.frames = new Map(rawFrameBodies(this.analysis));
    return { analysis: this.analysis, frames: this.frames };
  }

  /** §3.1 `name list <fn>` (P2.1a(b)) — delegates to the shared live-frame
   *  query so the CLI's bare `hbc2js name list` (no artifact) and this
   *  service agree by construction. */
  list(fn: number): readonly FrameNameableRegister[] {
    const { frames } = this.ensureFrames();
    return listNameable(frames, fn, this.overlay);
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
