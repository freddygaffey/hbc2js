// The M4 pipeline: bytes -> JavaScript.
//
//   parse (spec 01) -> decode (spec 02) -> CFG (spec 03) -> structure (spec 04)
//   -> emit (spec 05) -> `node --check`
//
// D11: this is the baseline. Output may be ugly — `while(true)` with `break`,
// register-named variables, `Reflect.apply` calls, duplicated `finally` bodies,
// generator shims — but it must pass the equivalence checker.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Diagnostic } from "./errors.ts";
import { ErrorCode, Hbc2jsError } from "./errors.ts";
import { analyseModule } from "./cfg/index.ts";
import type { AnalysisOptions, FunctionCfg } from "./cfg/types.ts";
import { emitModule } from "./emit/index.ts";
import type { EmitOptions } from "./emit/index.ts";
import { parseHbc } from "./parse/module.ts";
import type { HbcModule, OpcodeTableId } from "./parse/types.ts";
import { printTree, structure } from "./structure/index.ts";
import type { StructureOptions, StructuredFunction } from "./structure/index.ts";
import { astPassHook, passHook, runPasses } from "./passes/index.ts";
import type { PassPipelineOptions } from "./passes/index.ts";
import { printProgram } from "./emit/print.ts";
import type { Stmt } from "./emit/ast.ts";
import { resolveWorkerCount, runStageAPool } from "./parallel/pool.ts";
import type { StageAResult } from "./parallel/types.ts";

export interface DecompileOptions {
  readonly moduleName?: string;
  readonly opcodeTable?: OpcodeTableId;
  /**
   * Recover from `E_LAYOUT_AMBIGUOUS` by forcing `hbc98-late`. D8 forbids the
   * *parser* from guessing; this is the caller making the choice explicitly, and
   * it is reported in `diagnostics`. `tests/support/known-issues.ts` records the
   * external evidence for the eight v98 construct fixtures it applies to.
   */
  readonly resolveV98Ambiguity?: boolean;
  readonly analysis?: AnalysisOptions;
  readonly emit?: EmitOptions;
  /**
   * Spec 03 §6.4's R3 rule (`--lenient-env`). Default `true`: an environment
   * access the env graph cannot resolve statically refuses the whole module
   * with `E_ENV_UNRESOLVED`. `false` emits a loud `__hbc_unresolved_env(...)`
   * marker per site instead — it throws when reached, and every site is
   * reported as `W_ENV_UNRESOLVED` — so a production bundle with a handful of
   * unresolvable sites can still be read (review M4-H2).
   */
  readonly strictEnv?: boolean;
  /** Run the spec 04 §5 isomorphism check inline. Default true. */
  readonly verify?: boolean;
  /** Only emit this function's tree (`--emit-tree`, `--function`). */
  readonly functionIndex?: number;
  /**
   * Spec 07 pass pipeline. Every registered pass runs by default;
   * `{ skip: ["loop-cond"] }` is `--no-pass loop-cond`, `{ none: true }` is
   * `--passes=none` (the M4 baseline, PL-05).
   */
  readonly passes?: PassPipelineOptions;
  /**
   * INTERNAL — set only by `decompileParallel` (docs/perf/PARALLEL-DECOMPILE.md).
   * Precomputed stage-A (`structure()` + pass pipeline) results, keyed by
   * function index, from `src/parallel/pool.ts`'s worker pool. When present,
   * `decompile()` splices these fields into its own `structure(cfg)` result
   * instead of calling `opts.passes` inline — never `.graph` (not
   * structured-clone-safe; recomputed on the main thread regardless). Do not
   * set this directly; it bypasses the ordinary pass pipeline and is only
   * proven equivalent when the precomputing pool used the exact same
   * options `decompileParallel` derives.
   */
  readonly stageAResults?: ReadonlyMap<number, StageAResult>;
}

/** Shared by `decompile()` and `decompileParallel()` so both compute the
 *  exact same `structure()` options — a worker's stage-A result is only
 *  valid to splice in if it was produced against this same options object. */
function effectiveStructureOpts(opts: DecompileOptions): StructureOptions | undefined {
  if (opts.verify === false) return { ...opts.emit?.structure, verify: false };
  return opts.emit?.structure;
}

export interface DecompileResult {
  readonly code: string;
  readonly module: HbcModule;
  readonly helpersUsed: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
  readonly forcedOpcodeTable: boolean;
  /**
   * Count of functions that could not be decompiled and were replaced with a
   * throwing fallback stub instead of aborting the whole module (per-function
   * isolation — `W_FUNCTION_STUBBED` in `diagnostics`, see `src/emit/index.ts`
   * `emitOne`). Zero for every fixture; nonzero only on real apps hitting an
   * unsupported construct (docs/BUGS.md integration/E_EMIT_UNSUPPORTED row).
   */
  readonly decompileDiagnostics: number;
}

export function parseForDecompile(bytes: Uint8Array, opts: DecompileOptions = {}): { readonly module: HbcModule; readonly forced: boolean } {
  if (opts.opcodeTable !== undefined) return { module: parseHbc(bytes, { opcodeTable: opts.opcodeTable }), forced: true };
  try {
    return { module: parseHbc(bytes), forced: false };
  } catch (e) {
    if (opts.resolveV98Ambiguity === true && e instanceof Hbc2jsError && e.code === ErrorCode.E_LAYOUT_AMBIGUOUS) {
      return { module: parseHbc(bytes, { opcodeTable: "hbc98-late" }), forced: true };
    }
    throw e;
  }
}

// QUEUE "Perf part 3" (docs/reports/2026-09-03-architecture-sweep.md finding
// 1): opt-in stage timing, `HBC2JS_TIMINGS=1` — one small block, printed to
// stderr, `null` (the default) is a single env lookup and changes nothing
// else about `decompile()`. `structure()` itself runs *inside* `passHook`'s
// per-function callback (`runPasses`, `src/passes/index.ts`), which
// `emitModule` invokes once per function alongside `astPassHook`'s stage-B
// callback — neither stage is a separate top-level call this function makes
// directly, so "structure+stageA" and "stageB-astPasses" are measured by
// wrapping those two callbacks and accumulating their own wall time across
// every function, then treating whatever `emitModule` spent outside both
// callbacks as "emit" (printing, helper collection, …).
function timingsEnabled(): boolean {
  return process.env.HBC2JS_TIMINGS === "1";
}
function printTimings(label: string, marks: Record<string, number>): void {
  const total = Object.values(marks).reduce((a, b) => a + b, 0);
  const line = Object.entries(marks)
    .map(([k, v]) => `${k}=${v.toFixed(1)}ms`)
    .join(" ");
  process.stderr.write(`[hbc2js timings] ${label}: ${line} total=${total.toFixed(1)}ms\n`);
}

export function decompile(bytes: Uint8Array, opts: DecompileOptions = {}): DecompileResult {
  const timings = timingsEnabled();
  const t0 = timings ? performance.now() : 0;
  const { module, forced } = parseForDecompile(bytes, opts);
  const t1 = timings ? performance.now() : 0;
  const strictEnv = opts.strictEnv ?? true;
  const analysis = analyseModule(module, { strictEnv, ...opts.analysis });
  const t2 = timings ? performance.now() : 0;
  const diagnostics: Diagnostic[] = [...analysis.diagnostics];
  if (forced) {
    diagnostics.push({
      severity: "warn",
      code: "W_FORCED_OPCODE_TABLE",
      message: `opcode table forced to ${module.layout.opcodeTable ?? "?"}; the auto-probe found the file ambiguous`,
      context: { section: "decompile" },
    });
  }
  const structureOpts = effectiveStructureOpts(opts);
  // docs/perf/PARALLEL-DECOMPILE.md: when `decompileParallel` has precomputed
  // stage-A (structure()+passes) results, splice them into this function's
  // own `structure(cfg)` output (still computed here, on the main thread —
  // cheap, and the only source of `.graph`, which never crosses the worker
  // boundary) instead of calling the ordinary `passHook`. Falls back to it
  // for any index the pool did not cover (should never happen in practice;
  // defensive, not a silent partial-result path — `decompileParallel` awaits
  // full coverage before calling this).
  const stageA = opts.stageAResults;
  const ordinaryPasses = passHook(analysis, opts.passes);
  const passesHook =
    stageA === undefined
      ? ordinaryPasses
      : (fn: StructuredFunction, cfg: FunctionCfg) => {
          const r = stageA.get(cfg.functionIndex);
          if (r === undefined) return ordinaryPasses(fn, cfg);
          return {
            fn: { ...fn, root: r.root, labels: r.labels, dispatchVars: r.dispatchVars, duplicatedBlocks: r.duplicatedBlocks, stats: r.stats },
            diagnostics: r.diagnostics,
          };
        };
  let structureAndStageAMs = 0;
  let stageBMs = 0;
  const timedPassesHook = !timings
    ? passesHook
    : (fn: StructuredFunction, cfg: FunctionCfg) => {
        const a = performance.now();
        const out = passesHook(fn, cfg);
        structureAndStageAMs += performance.now() - a;
        return out;
      };
  const rawAstPasses = astPassHook(analysis, opts.passes);
  const timedAstPasses = !timings
    ? rawAstPasses
    : (fn: Parameters<typeof rawAstPasses>[0], cfg: FunctionCfg) => {
        const a = performance.now();
        const out = rawAstPasses(fn, cfg);
        stageBMs += performance.now() - a;
        return out;
      };
  const t3 = timings ? performance.now() : 0;
  const result = emitModule(analysis, {
    moduleName: opts.moduleName ?? "input.hbc",
    provenanceComments: false,
    strictEnv,
    passes: timedPassesHook,
    astPasses: timedAstPasses,
    ...opts.emit,
    ...(structureOpts !== undefined ? { structure: structureOpts } : {}),
  });
  const t4 = timings ? performance.now() : 0;
  if (timings) {
    printTimings("decompile", {
      parse: t1 - t0,
      analyse: t2 - t1,
      "structure+stageA": structureAndStageAMs,
      "stageB-astPasses": stageBMs,
      emit: t4 - t3 - structureAndStageAMs - stageBMs,
    });
  }
  return {
    code: result.code,
    module,
    helpersUsed: result.helpersUsed,
    diagnostics: [...diagnostics, ...result.diagnostics],
    forcedOpcodeTable: forced,
    decompileDiagnostics: result.stubbedFunctions,
  };
}

/**
 * docs/perf/PARALLEL-DECOMPILE.md — part 1. Byte-identical to `decompile()`
 * for the same `bytes`/`opts`; the only difference is where the stage-A
 * (structure()+pass pipeline) work happens. `workers=1` (the default when
 * `cpus - 2 <= 1`, or an explicit `{ workers: 1 }`, or `HBC2JS_WORKERS=1`)
 * takes `decompile()`'s exact serial path — no `Worker` is spawned.
 */
export async function decompileParallel(bytes: Uint8Array, opts: DecompileOptions = {}, workers?: number): Promise<DecompileResult> {
  const workerCount = resolveWorkerCount(workers);
  if (workerCount <= 1) return decompile(bytes, opts);

  const { module, forced } = parseForDecompile(bytes, opts);
  const strictEnv = opts.strictEnv ?? true;
  const indices = module.functions.map((_, i) => i);
  const stageAResults = await runStageAPool(
    bytes,
    indices,
    {
      opcodeTable: module.layout.opcodeTable,
      strictEnv,
      analysis: opts.analysis,
      structureOpts: effectiveStructureOpts(opts),
      passesOpts: opts.passes,
    },
    workerCount,
  );
  // A worker cannot redo `parseForDecompile`'s ambiguity resolution (it
  // would throw `E_LAYOUT_AMBIGUOUS` on a genuinely ambiguous v98 file), so
  // it is always given the exact table the main thread's probe/forcing just
  // resolved (above). The follow-up `decompile()` call below must NOT pass
  // that through as `opts.opcodeTable`, though, unless the original call
  // already forced one: `opts.opcodeTable !== undefined` is `parseForDecompile`'s
  // own "was this forced" test (`forced: true` unconditionally), so doing it
  // for a run that was never ambiguous (`forced === false`) would spuriously
  // flip `forcedOpcodeTable`/add `W_FORCED_OPCODE_TABLE` relative to
  // `decompile()`'s own serial result — a metadata drift the byte-identity
  // gate doesn't catch (it's not part of `code`) but would still be wrong.
  return decompile(bytes, { ...opts, ...(forced && module.layout.opcodeTable !== undefined ? { opcodeTable: module.layout.opcodeTable } : {}), stageAResults });
}

/** `--emit-tree`: the structurer's tree IR for one function (or all of them). */
export function decompileTree(bytes: Uint8Array, opts: DecompileOptions = {}): string {
  const { module } = parseForDecompile(bytes, opts);
  const analysis = analyseModule(module, { strictEnv: opts.strictEnv ?? true, ...opts.analysis });
  const indices = opts.functionIndex !== undefined ? [opts.functionIndex] : module.functions.map((_, i) => i);
  const out: string[] = [];
  for (const i of indices) {
    const cfg = analysis.cfg(i);
    const structured = structure(cfg, { verify: opts.verify !== false });
    const passed = runPasses(analysis, structured, cfg, opts.passes);
    const s = passed.fn;
    out.push(`; fn#${i} ${JSON.stringify(analysis.decoded(i).name)}  ${JSON.stringify(s.stats)}${passed.applied.length > 0 ? `  passes=${passed.applied.map((a) => `${a.pass}@${a.at.offset}`).join(",")}` : ""}${passed.abandoned.length > 0 ? `  abandoned=${passed.abandoned.map((a) => `${a.pass}@${a.at.offset}(${a.reason})`).join(",")}` : ""}`);
    out.push(printTree(s));
  }
  return out.join("\n");
}

/** F1: `--emit-ast` mirrors `--emit-tree`, one function's stage-B JS AST at a
 *  time, each with a `passes=…`/`abandoned=…` header — but *after* emission,
 *  since the JS AST only exists once `emitFunction` has run. Reuses the real
 *  `emitModule` traversal (children hoisted/inlined exactly as production
 *  does) and taps `astPasses` to capture each function's own body and report
 *  before it is spliced into its parent. */
export function decompileAst(bytes: Uint8Array, opts: DecompileOptions = {}): string {
  const { module } = parseForDecompile(bytes, opts);
  const strictEnv = opts.strictEnv ?? true;
  const analysis = analyseModule(module, { strictEnv, ...opts.analysis });
  const headers = new Map<number, string>();
  const bodies = new Map<number, Stmt>();
  const hook = astPassHook(analysis, opts.passes, (functionIndex, r) => {
    const parts: string[] = [];
    if (r.applied.length > 0) parts.push(`passes=${r.applied.map((a) => `${a.pass}@${a.at.offset}`).join(",")}`);
    if (r.abandoned.length > 0) parts.push(`abandoned=${r.abandoned.map((a) => `${a.pass}@${a.at.offset}(${a.reason})`).join(",")}`);
    headers.set(functionIndex, parts.join("  "));
  });
  emitModule(analysis, {
    moduleName: opts.moduleName ?? "input.hbc",
    provenanceComments: false,
    strictEnv,
    passes: passHook(analysis, opts.passes),
    astPasses: (fn, cfg) => {
      const out = hook(fn, cfg);
      if (out.fn.k === "func") bodies.set(cfg.functionIndex, out.fn);
      return out;
    },
    ...opts.emit,
    ...(opts.verify === false ? { structure: { ...opts.emit?.structure, verify: false } } : {}),
  });
  const indices = opts.functionIndex !== undefined ? [opts.functionIndex] : [...bodies.keys()].sort((a, b) => a - b);
  const out: string[] = [];
  for (const i of indices) {
    const body = bodies.get(i);
    if (body === undefined) continue;
    const header = headers.get(i) ?? "";
    out.push(`; fn#${i}${header.length > 0 ? `  ${header}` : ""}`);
    out.push(printProgram([body], { indent: "  ", jsx: opts.emit?.jsx === true }));
  }
  return out.join("\n");
}

/** EM-02 — the cheapest gate there is, and it catches a whole bug class. */
export function nodeCheck(code: string): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-check-"));
  const file = join(dir, "candidate.js");
  try {
    writeFileSync(file, code);
    execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
    return { ok: true };
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr;
    return { ok: false, message: stderr !== undefined ? stderr.toString().split("\n").slice(0, 6).join("\n") : String(e) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
