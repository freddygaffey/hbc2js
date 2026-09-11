// docs/perf/PARALLEL-DECOMPILE.md -- part 2: the same worker pool, for the
// readability layer's whole-bundle setup (`hbc2js name ...`, `readability
// rewrite/review`, `src/readability/surfaces.ts`).
//
// WHERE THE TIME ACTUALLY GOES. `analyseModule` (src/cfg/index.ts) is lazy:
// it eagerly decodes every function and classifies kinds (seconds on a 12 MB
// bundle) and then hands back accessors. The ~30 minutes Fred measured on the
// Service NSW bundle is NOT inside those accessors -- it is the consumer
// forcing every function through `rawFrames`/`rawFrameBodies`
// (src/name-overlay/frames.ts), which runs `emitModule` over the whole
// module: `structure(cfg)` plus the stage-A D12 pass pipeline per function,
// the exact work `decompileParallel` already fans out (the design note's
// "55x-dominant cost"). So parallelising "the analysis" means running that
// stage-A work in the pool and splicing the results into the main thread's
// emit, byte-for-byte the way `decompile()` splices `stageAResults`. See
// docs/PUSHBACK.md P-62.
//
// The `ModuleAnalysis` handed back is therefore the ordinary
// `analyseModule(module, opts)` object -- same shape, same accessors, same
// lazily-observable values, same diagnostics order -- with the precomputed
// stage-A map recorded in a side table (`STAGE_A`, a WeakMap keyed by the
// analysis). Nothing is added to `ModuleAnalysis`, so serial and parallel
// analyses are deep-equal by construction, not by convergence.
import { analyseModule } from "../cfg/index.ts";
import type { AnalysisOptions, FunctionCfg, ModuleAnalysis } from "../cfg/types.ts";
import { parseHbc } from "../parse/module.ts";
import type { OpcodeTableId } from "../parse/types.ts";
import type { StructureOptions, StructuredFunction } from "../structure/index.ts";
import { passHook } from "../passes/index.ts";
import type { PassHook, PassPipelineOptions } from "../passes/index.ts";
import { resolveWorkerCount, runStageAPool } from "./pool.ts";
import type { StageAResult } from "./types.ts";

/**
 * Below this many functions the pool is never used: spawning N workers that
 * each re-parse and re-analyse the bundle costs more than the stage-A work it
 * saves. The number is measured, not guessed (2026-09-11, 10-core M-series,
 * 1-min load 2.8-8.8, full `rawFrameBodies` forcing):
 *
 *   rn-template      4,199 fns   serial 1.4 s wall / 2.7 s cpu
 *                                pooled 1.7 s wall / 8.8 s cpu   REGRESSION
 *   react-navigation 15,551 fns  serial 12.3 s wall / 17.6 s cpu
 *                                pooled 12.4 s wall / 32.8 s cpu  neutral
 *
 * Stage-A is only ~33% of the readability setup on those two bundles (the
 * rest is `emitModule`'s own per-function emit + print on the main thread),
 * so Amdahl caps the win at ~1.5x there and the pool's own ~1-4 s of parse
 * per worker eats it. The threshold is therefore set above both, at the
 * NSW-class size where the design note's pass-dominated profile (and Fred's
 * 29-minute single-core measurement) says stage-A is the cost. See
 * docs/PUSHBACK.md P-62 for the full argument and the numbers.
 *
 * `HBC2JS_ANALYSIS_POOL=1` forces the pool on regardless of size, `=0` off;
 * `minFunctions` overrides both per call (the parity tests force it to 0).
 */
export const DEFAULT_MIN_FUNCTIONS = 20_000;

/** `HBC2JS_ANALYSIS_POOL`: `1`/`true` force on, `0`/`false` force off,
 *  unset = the `DEFAULT_MIN_FUNCTIONS` rule. */
function poolOverride(): boolean | null {
  const v = process.env.HBC2JS_ANALYSIS_POOL;
  if (v === undefined || v.trim().length === 0) return null;
  const t = v.trim().toLowerCase();
  if (t === "1" || t === "true") return true;
  if (t === "0" || t === "false") return false;
  return null;
}

export interface ParallelAnalysisOptions {
  /** Spec 03 section 6.4's R3 rule; default `true`, as `buildAnalysis` uses. */
  readonly strictEnv?: boolean;
  readonly analysis?: AnalysisOptions;
  readonly opcodeTable?: OpcodeTableId;
  /** The stage-A pass options the CONSUMER will emit with. A precomputed
   *  result is only spliced back in when these match exactly (see
   *  `stageAPassHook`), so a mismatch is slow, never wrong. */
  readonly passes?: PassPipelineOptions;
  readonly structure?: StructureOptions;
  /** See `DEFAULT_MIN_FUNCTIONS`. */
  readonly minFunctions?: number;
}

interface StageARecord {
  readonly key: string;
  readonly results: ReadonlyMap<number, StageAResult>;
}

const STAGE_A = new WeakMap<ModuleAnalysis, StageARecord>();

/** The identity of a stage-A precomputation: the options it was computed
 *  under. `undefined` and `{}` are the same request; key order is normalised
 *  by `JSON.stringify` over sorted keys so `{a,b}` and `{b,a}` agree. */
function stageAKey(passes: PassPipelineOptions | undefined, structure: StructureOptions | undefined): string {
  const norm = (o: unknown): unknown => {
    if (o === undefined || o === null) return null;
    if (Array.isArray(o)) return o.map(norm);
    if (typeof o === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o as Record<string, unknown>).sort()) out[k] = norm((o as Record<string, unknown>)[k]);
      return out;
    }
    return o;
  };
  return JSON.stringify([norm(passes), norm(structure)]);
}

/** Test/introspection hook: how many functions a precomputed stage-A map
 *  covers for this analysis, or `null` when the serial path was taken. */
export function stageACoverage(analysis: ModuleAnalysis): number | null {
  const rec = STAGE_A.get(analysis);
  return rec === undefined ? null : rec.results.size;
}

/**
 * The `passes` hook for `emitModule`. Identical to `passHook(analysis, opts)`
 * except that, for any function the pool already computed under the SAME
 * options, it returns the worker's result instead of re-running the pipeline
 * -- exactly the splice `decompile()` performs for `opts.stageAResults`,
 * including never touching `.graph` (not structured-clone-safe; the main
 * thread's own `structure(cfg)` remains the only source of it).
 */
export function stageAPassHook(analysis: ModuleAnalysis, passes?: PassPipelineOptions, structure?: StructureOptions): PassHook {
  const ordinary = passHook(analysis, passes);
  const rec = STAGE_A.get(analysis);
  if (rec === undefined || rec.key !== stageAKey(passes, structure)) return ordinary;
  const results = rec.results;
  return (fn: StructuredFunction, cfg: FunctionCfg) => {
    const r = results.get(cfg.functionIndex);
    if (r === undefined) return ordinary(fn, cfg);
    return {
      fn: { ...fn, root: r.root, labels: r.labels, dispatchVars: r.dispatchVars, duplicatedBlocks: r.duplicatedBlocks, stats: r.stats },
      diagnostics: r.diagnostics,
    };
  };
}

/**
 * Whole-bundle analysis for the readability layer, with the per-function
 * stage-A work fanned out across worker threads. The returned
 * `ModuleAnalysis` is the ordinary serial one; consumers that go through
 * `rawFrames`/`rawFrameBodies` pick the precomputed stage-A up automatically.
 *
 * `workers <= 1`, `HBC2JS_WORKERS=1`, or a module below `minFunctions` takes
 * the exact serial path -- no `Worker` is spawned -- so it is byte-identical
 * to `analyseModule(parseHbc(bytes), opts)` by construction.
 */
export async function analyseModuleParallel(bytes: Uint8Array, opts: ParallelAnalysisOptions = {}, workers?: number): Promise<ModuleAnalysis> {
  const strictEnv = opts.strictEnv ?? true;
  const module = parseHbc(bytes, opts.opcodeTable !== undefined ? { opcodeTable: opts.opcodeTable } : {});
  const analysis = analyseModule(module, { strictEnv, ...opts.analysis });

  const workerCount = resolveWorkerCount(workers);
  const override = poolOverride();
  const minFunctions = opts.minFunctions ?? DEFAULT_MIN_FUNCTIONS;
  const wanted = override ?? module.functions.length >= minFunctions;
  if (workerCount <= 1 || !(opts.minFunctions !== undefined ? module.functions.length >= minFunctions : wanted)) return analysis;

  const indices = module.functions.map((_, i) => i);
  const results = await runStageAPool(
    bytes,
    indices,
    {
      opcodeTable: module.layout.opcodeTable,
      strictEnv,
      analysis: opts.analysis,
      structureOpts: opts.structure,
      passesOpts: opts.passes,
    },
    workerCount,
  );
  STAGE_A.set(analysis, { key: stageAKey(opts.passes, opts.structure), results });
  return analysis;
}
