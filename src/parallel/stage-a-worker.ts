// docs/perf/PARALLEL-DECOMPILE.md — the part 1 worker.
//
// Each worker independently re-parses/re-analyses the same bytes (the cheap
// ~12s-class work, per the design note) and then computes ONLY the stage-A
// pass result (`runPasses`, the proven 55x-dominant cost) for its assigned
// function indices. It never touches anything cross-function, and it never
// sends `StructuredFunction.graph` back across the thread boundary — that
// carries a `dominates` closure, which is not structured-clone-safe — the
// main thread recomputes `structure(cfg)` itself (cheap) and splices in only
// the fields a stage-A pass can change.
import { parentPort, workerData } from "node:worker_threads";
import { analyseModule } from "../cfg/index.ts";
import type { AnalysisOptions } from "../cfg/types.ts";
import { parseHbc } from "../parse/module.ts";
import type { OpcodeTableId } from "../parse/types.ts";
import { structure } from "../structure/index.ts";
import type { StructureOptions } from "../structure/index.ts";
import { buildModuleView, runPasses } from "../passes/index.ts";
import type { PassPipelineOptions } from "../passes/index.ts";
import type { StageAResult, WorkerRequest } from "./types.ts";

function run(): void {
  const req = workerData as WorkerRequest;
  const bytes = new Uint8Array(req.bytes);
  const module = parseHbc(bytes, req.opcodeTable !== undefined ? { opcodeTable: req.opcodeTable as OpcodeTableId } : {});
  const analysis = analyseModule(module, { strictEnv: req.strictEnv, ...(req.analysis as AnalysisOptions | undefined) });
  const moduleView = buildModuleView(analysis);
  const results: StageAResult[] = [];
  for (const index of req.indices) {
    const cfg = analysis.cfg(index);
    const structured = structure(cfg, req.structureOpts as StructureOptions | undefined);
    const passed = runPasses(analysis, structured, cfg, (req.passesOpts as PassPipelineOptions | undefined) ?? {}, moduleView);
    results.push({
      index,
      root: passed.fn.root,
      labels: passed.fn.labels,
      dispatchVars: passed.fn.dispatchVars,
      duplicatedBlocks: passed.fn.duplicatedBlocks,
      stats: passed.fn.stats,
      diagnostics: passed.diagnostics,
    });
  }
  parentPort!.postMessage({ ok: true, results });
}

try {
  run();
} catch (e) {
  const err = e as { message?: string; stack?: string };
  parentPort!.postMessage({ ok: false, error: { message: err.message ?? String(e), stack: err.stack } });
}
