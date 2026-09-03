// docs/perf/PARALLEL-DECOMPILE.md — message shapes crossing the
// `worker_threads` boundary. Every field here must be structured-clone-safe
// (plain data only — no functions, no `AugmentedCfg.graph`).
import type { DispatchVar, LabelInfo, Stmt, StructureStats } from "../structure/ir.ts";
import type { Diagnostic } from "../errors.ts";
import type { BlockId } from "../cfg/types.ts";

export interface WorkerRequest {
  readonly bytes: Uint8Array;
  /** Undefined means "let the worker auto-probe" — only valid when the main
   *  thread's own `parseForDecompile` would do the same (no ambiguity to
   *  resolve, so the probe is a deterministic pure function of `bytes`
   *  either way). When the main thread forced a table, that exact table is
   *  passed here so a worker cannot land on a different one (D8). */
  readonly opcodeTable: string | undefined;
  readonly strictEnv: boolean;
  readonly analysis: unknown;
  readonly structureOpts: unknown;
  readonly passesOpts: unknown;
  readonly indices: readonly number[];
}

/** The subset of `StructuredFunction` a stage-A pass can change — never
 *  `.graph` (its `dominates` closure isn't structured-clone-safe) or
 *  `.functionIndex` (identity, fixed by the request). */
export interface StageAResult {
  readonly index: number;
  readonly root: Stmt;
  readonly labels: readonly LabelInfo[];
  readonly dispatchVars: readonly DispatchVar[];
  readonly duplicatedBlocks: readonly BlockId[];
  readonly stats: StructureStats;
  readonly diagnostics: readonly Diagnostic[];
}

export type WorkerResponse = { readonly ok: true; readonly results: readonly StageAResult[] } | { readonly ok: false; readonly error: { readonly message: string; readonly stack?: string } };
