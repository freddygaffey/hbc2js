// src/ui-server/cfg.ts — `GET /api/fn/{fn}/cfg`, the read-only per-function
// control-flow graph (docs/specs/26-ui-full-ide.md L9; the follow-up
// docs/specs/25-ui-graph-view.md §3 mode 3 / §7 named).
//
// WHY HERE AND NOT `src/mcp/resources.ts` (spec 26 L9 asks the landing to
// decide and say why): the MCP surface is the AGENT-facing contract
// (spec 17 §14 deliberately cut whole-catalogue reads from it, and every
// resource there is a documented tool an agent may call). A block graph is
// a RENDERING aid for one pane — the UI needs it to draw spec 25 mode 3,
// no agent workflow asks for it — so growing `McpResources` would widen the
// agent contract, its docs and its tests for a UI-only need. `screens.ts`
// set exactly this precedent one landing earlier: a route file of its own,
// registered with one line in `routes.ts`, reading the SAME shared
// `McpResources`/`ArtifactService` pair. If an agent workflow ever needs the
// CFG, `McpResources.cfg()` becomes a one-line delegation to `cfgOf` below.
//
// EVERY field is derived from `src/cfg`'s own block graph — this file never
// re-derives blocks, leaders, edges or exception regions from bytes
// (CLAUDE.md: reuse the pipeline's structures, never a second implementation
// of them). The source-line span per block is the SAME `lineMap` the listing
// aligns with (docs/specs/05-emitter.md §16), so a block and the listing
// cannot disagree about which lines it covers.
import { Hbc2jsError } from "../errors.ts";
import type { LineMapEntry } from "../emit/origin.ts";
import type { EdgeKind, FunctionCfg } from "../cfg/types.ts";
import type { UiRequest, UiResponse, UiServerCtx } from "./routes.ts";

/** Published cap on drawn blocks, mirroring the graph pane's own
 *  `GRAPH_NODE_CAP` (spec 25 §5): the blocks ARE the nodes at the `near`
 *  level, so one cap governs both. Overflow is reported, never silently
 *  trimmed. */
export const CFG_BLOCK_CAP = 300;

/** `src/cfg`'s normal edge kinds plus `exception`, which `src/cfg` keeps in
 *  a separate map (CFG-03: exception edges are never block successors). The
 *  UI draws them dashed, like every other unproven-flow edge. */
export type CfgEdgeKind = EdgeKind | "exception";

export interface CfgBlockRow {
  readonly id: number;
  /** Function-relative byte offset, inclusive (`-1` for spec 03 §4.5's
   *  synthetic block, flagged by `synthetic`). */
  readonly start: number;
  /** Function-relative byte offset, EXCLUSIVE. */
  readonly end: number;
  readonly instructions: number;
  readonly terminator: string;
  readonly isHandlerEntry: boolean;
  readonly entry: boolean;
  readonly exit: boolean;
  readonly synthetic: boolean;
  /** 1-based `[first, last]` line span inside the FUNCTION's own decompiled
   *  text (what `/api/fn/{fn}/source` returns), or `null` when the render
   *  mapped no line into this block's byte range — an honest gap, never a
   *  guessed neighbouring line. */
  readonly lines: readonly [number, number] | null;
  /** The same span rebased into the module file (`fnStartLine` + span), for
   *  the whole-module listing the centre pane shows. `null` whenever `lines`
   *  is `null` or the function's own start line is unknown. */
  readonly fileLines: readonly [number, number] | null;
}

export interface CfgEdgeRow {
  readonly from: number;
  readonly to: number;
  readonly kind: CfgEdgeKind;
  /** switch-case only: the integer case value, or the case-label string id. */
  readonly caseValue?: number;
  /** switch-case only: true when `caseValue` indexes the string table. */
  readonly caseIsString?: boolean;
}

export interface CfgRegionRow {
  readonly index: number;
  readonly startPc: number;
  /** EXCLUSIVE, as `src/cfg`'s own `ExceptionRegion.endPc` is. */
  readonly endPc: number;
  readonly handlerBlock: number;
  readonly catchRegister: number;
  readonly parent: number | null;
  /** The region's body blocks, restricted to blocks THIS response contains
   *  (the cap can drop a body block; the region itself is still reported). */
  readonly blocks: readonly number[];
}

export interface CfgResult {
  readonly fn: number;
  readonly entry: number;
  /** The function's first line in its module file, so a caller showing the
   *  whole file can rebase `lines` itself — same field, same meaning as
   *  `/api/fn/{fn}/linemap`'s. */
  readonly fnStartLine: number | null;
  readonly blocks: readonly CfgBlockRow[];
  readonly edges: readonly CfgEdgeRow[];
  readonly regions: readonly CfgRegionRow[];
  /** Blocks the function has, drawn or not. */
  readonly total: number;
  readonly shown: number;
  /** Blocks the cap dropped. `truncated` is exactly `hidden > 0`. */
  readonly hidden: number;
  readonly truncated: boolean;
  readonly cap: number;
}

/** The narrow slice of `FunctionCfg` this file needs. Declared separately so
 *  the pure core below is testable on synthetic graphs (the cap and the
 *  dangling-edge rules must hold for shapes no committed fixture has)
 *  without building a whole `FunctionCfg` (dominators, generator shape and
 *  all) by hand. */
export interface CfgInput {
  readonly fn: number;
  readonly entry: number;
  readonly exits: readonly number[];
  readonly rpo: readonly number[];
  readonly blocks: readonly {
    readonly id: number;
    readonly start: number;
    readonly end: number;
    readonly instructions: number;
    readonly terminator: string;
    readonly isHandlerEntry: boolean;
    readonly succs: readonly { readonly to: number; readonly kind: EdgeKind; readonly caseValue?: number; readonly caseIsString?: boolean }[];
  }[];
  readonly exceptionSuccs: readonly (readonly [number, readonly number[]])[];
  readonly regions: readonly {
    readonly index: number;
    readonly startPc: number;
    readonly endPc: number;
    readonly handlerBlock: number;
    readonly catchRegister: number;
    readonly parent: number | null;
    readonly bodyBlocks: readonly number[];
  }[];
}

/** `FunctionCfg` -> `CfgInput`. Pure projection, no re-derivation. */
export function cfgInputOf(cfg: FunctionCfg): CfgInput {
  return {
    fn: cfg.functionIndex,
    entry: cfg.entry,
    exits: [...cfg.exits],
    rpo: [...cfg.rpo],
    blocks: cfg.blocks.map((b) => ({
      id: b.id,
      start: b.start,
      end: b.end,
      instructions: b.instructions.length,
      terminator: b.terminator.kind,
      isHandlerEntry: b.isHandlerEntry,
      succs: b.succs.map((e) => ({
        to: e.to,
        kind: e.kind,
        ...(e.caseValue !== undefined ? { caseValue: e.caseValue } : {}),
        ...(e.caseIsString !== undefined ? { caseIsString: e.caseIsString } : {}),
      })),
    })),
    exceptionSuccs: [...cfg.exceptionSuccs].map(([from, tos]) => [from, [...tos]] as const),
    regions: cfg.regions.map((r) => ({
      index: r.index,
      startPc: r.startPc,
      endPc: r.endPc,
      handlerBlock: r.handlerBlock,
      catchRegister: r.catchRegister,
      parent: r.parent,
      bodyBlocks: [...r.bodyBlocks],
    })),
  };
}

/** Which blocks survive the cap: reverse-postorder first (the entry, then
 *  the reachable body in the order an analyst reads it), then anything the
 *  RPO does not name (unreachable blocks) by id — so the drawn subgraph is
 *  always rooted at the entry and always deterministic. */
function keptBlockIds(input: CfgInput, cap: number): ReadonlySet<number> {
  const present = new Set(input.blocks.map((b) => b.id));
  const order: number[] = [];
  const seen = new Set<number>();
  for (const id of input.rpo) {
    if (present.has(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  for (const b of [...input.blocks].sort((a, z) => a.id - z.id)) if (!seen.has(b.id)) order.push(b.id);
  return new Set(order.slice(0, Math.max(0, cap)));
}

/** `[first, last]` 1-based line span of the rows whose instruction offset
 *  falls inside `[start, end)`. Rows for OTHER functions (a nested closure
 *  printed inline, spec 05 §16.1) index a different listing and are
 *  ignored. `null` when nothing mapped — an honest gap. */
function lineSpan(rows: readonly LineMapEntry[], fn: number, start: number, end: number): readonly [number, number] | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const [line, rowFn, off] of rows) {
    if (rowFn !== fn || off < start || off >= end) continue;
    if (line < lo) lo = line;
    if (line > hi) hi = line;
  }
  return hi < lo ? null : [lo, hi];
}

/** The pure core: block graph + line map in, wire contract out. */
export function buildCfgResult(
  input: CfgInput,
  opts: { readonly lineMap?: readonly LineMapEntry[]; readonly fnStartLine?: number | null; readonly cap?: number } = {},
): CfgResult {
  const cap = opts.cap ?? CFG_BLOCK_CAP;
  const rows = opts.lineMap ?? [];
  const fnStartLine = opts.fnStartLine ?? null;
  const kept = keptBlockIds(input, cap);
  const exits = new Set(input.exits);

  const blocks: CfgBlockRow[] = [];
  for (const b of [...input.blocks].sort((a, z) => a.id - z.id)) {
    if (!kept.has(b.id)) continue;
    const synthetic = b.start < 0 || b.end < 0;
    const lines = synthetic ? null : lineSpan(rows, input.fn, b.start, b.end);
    blocks.push({
      id: b.id,
      start: b.start,
      end: b.end,
      instructions: b.instructions,
      terminator: b.terminator,
      isHandlerEntry: b.isHandlerEntry,
      entry: b.id === input.entry,
      exit: exits.has(b.id),
      synthetic,
      lines,
      fileLines: lines !== null && fnStartLine !== null ? [lines[0] + fnStartLine - 1, lines[1] + fnStartLine - 1] : null,
    });
  }

  // Every edge must name a block the response also contains — a dangling
  // edge is a lie about the drawn graph, so the cap drops it with its block
  // (the same rule spec 25 §5's node cap applies in the UI).
  const edges: CfgEdgeRow[] = [];
  for (const b of input.blocks) {
    if (!kept.has(b.id)) continue;
    for (const e of b.succs) {
      if (!kept.has(e.to)) continue;
      edges.push({
        from: b.id,
        to: e.to,
        kind: e.kind,
        ...(e.caseValue !== undefined ? { caseValue: e.caseValue } : {}),
        ...(e.caseIsString !== undefined ? { caseIsString: e.caseIsString } : {}),
      });
    }
  }
  for (const [from, tos] of input.exceptionSuccs) {
    if (!kept.has(from)) continue;
    for (const to of tos) if (kept.has(to)) edges.push({ from, to, kind: "exception" });
  }

  // Regions are reported whole — an exception region the analyst cannot see
  // is exactly the thing this route exists to stop hiding. Only its body
  // block LIST is restricted to blocks this response contains.
  const regions: CfgRegionRow[] = input.regions.map((r) => ({
    index: r.index,
    startPc: r.startPc,
    endPc: r.endPc,
    handlerBlock: r.handlerBlock,
    catchRegister: r.catchRegister,
    parent: r.parent,
    blocks: [...r.bodyBlocks].filter((id) => kept.has(id)).sort((a, z) => a - z),
  }));

  const hidden = input.blocks.length - blocks.length;
  return {
    fn: input.fn,
    entry: input.entry,
    fnStartLine,
    blocks,
    edges,
    regions,
    total: input.blocks.length,
    shown: blocks.length,
    hidden,
    truncated: hidden > 0,
    cap,
  };
}

/** The route's own ctx slice — `screens.ts`'s idiom: name what is read, so
 *  a test needs no `McpTools`. */
export interface CfgCtx {
  readonly resources: UiServerCtx["resources"];
}

/** `null` = the route DECLINES this function (no `--hbc` to analyse, or the
 *  analysis itself failed on it). The UI falls back to spec 25 §5b's
 *  `lodCard` rather than drawing an empty graph. `undefined` fn = no such
 *  function in this artifact (a 404 of a different kind, told apart by the
 *  caller through `hasFn`). */
export function cfgOf(ctx: CfgCtx, fn: number): CfgResult | null {
  let cfg;
  try {
    cfg = ctx.resources.artifact.functionCfg(fn);
  } catch (e) {
    // A live-verb constraint (no `--hbc`) or an analysis failure on this one
    // function is a DECLINE, not a 500: every other route keeps working.
    if (e instanceof Hbc2jsError) return null;
    throw e;
  }
  if (cfg === null) return null;
  const lm = ctx.resources.lineMap(fn);
  return buildCfgResult(cfgInputOf(cfg), { lineMap: lm.lines, fnStartLine: lm.fnStartLine });
}

interface Route {
  readonly method: "GET" | "POST";
  readonly re: RegExp;
  readonly handler: (params: readonly string[], req: UiRequest, ctx: UiServerCtx) => UiResponse | Promise<UiResponse>;
}

export const CFG_ROUTES: readonly Route[] = [
  {
    method: "GET",
    re: /^\/api\/fn\/([^/]+)\/cfg$/,
    handler: ([raw], _req, ctx) => {
      const n = Number(raw);
      if (!Number.isInteger(n)) return { status: 400, json: { reason: `fn/${raw}/cfg: not a function index` } };
      if (!ctx.resources.artifact.hasFn(n)) return { status: 404, json: { reason: `fn/${n}/cfg: no such function in this artifact` } };
      const r = cfgOf(ctx, n);
      if (r === null) return { status: 404, json: { reason: `fn/${n}/cfg: no block graph available (the project has no --hbc, or the analysis declined this function)` } };
      return { status: 200, json: r };
    },
  },
];
