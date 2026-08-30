// The pass pipeline as src/decompile.ts wires it: runs after the structurer's
// tree IR and before emit (spec 07 §1), for every function.
import type { Diagnostic } from "../errors.ts";
import type { FunctionCfg, ModuleAnalysis } from "../cfg/types.ts";
import type { Stmt, StructuredFunction } from "../structure/ir.ts";
import { applyPasses } from "./driver.ts";
import type { ApplyResult } from "./driver.ts";
import { enabledPasses, REGISTRY } from "./registry.ts";
import type { EnabledPassOptions } from "./registry.ts";
import type { Pass } from "./types.ts";

export { applyPasses } from "./driver.ts";
export { enabledPasses, REGISTRY } from "./registry.ts";
export type { Pass, PassContext, Match, CheckResult, AppliedRecord, AbandonedRecord } from "./types.ts";

export interface PassPipelineOptions extends EnabledPassOptions {
  /** `--passes=none`: run nothing, reproduce the M4 baseline byte for byte. */
  readonly none?: boolean;
}

export type PassHook = (fn: StructuredFunction, cfg: FunctionCfg) => { readonly fn: StructuredFunction; readonly diagnostics: readonly Diagnostic[] };

export function runPasses(analysis: ModuleAnalysis, fn: StructuredFunction, cfg: FunctionCfg, opts: PassPipelineOptions = {}): ApplyResult {
  const passes = opts.none === true ? [] : (enabledPasses({ ...opts, stage: "A" }) as readonly Pass<Stmt>[]);
  const mod = analysis.module;
  const diagnostics: Diagnostic[] = [];
  const result = applyPasses(fn, passes, {
    analysis,
    functionIndex: cfg.functionIndex,
    cfg,
    hbcVersion: mod.header.version,
    layoutClass: mod.layout.layoutClass,
    diagnostic: (d) => diagnostics.push(d),
  });
  return { ...result, diagnostics: [...diagnostics, ...result.diagnostics] };
}

/** The hook `EmitOptions.passes` takes. */
export function passHook(analysis: ModuleAnalysis, opts: PassPipelineOptions = {}): PassHook {
  return (fn, cfg) => {
    const r = runPasses(analysis, fn, cfg, opts);
    return { fn: r.fn, diagnostics: r.diagnostics };
  };
}

/** `--list-passes`. */
export function describePasses(): string {
  return REGISTRY.map((p) => `${p.name}\tstage ${p.stage}\tcatalogue rows ${p.catalogue.join(",")}\tfixtures ${p.targets.join(",")}${p.after ? `\tafter ${p.after.join(",")}` : ""}`).join("\n");
}
