// docs/specs/04-structurer.md §3 — public API.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { Diagnostic } from "../errors.ts";
import type { FunctionCfg } from "../cfg/types.ts";
import { augment } from "./augment.ts";
import { maxNesting } from "./ir.ts";
import type { DispatchVar, StructuredFunction } from "./ir.ts";
import { dispatchStructure, NeedDispatch, ramsey } from "./structure.ts";
import { checkIsomorphic, reconstruct } from "./verify.ts";

export * from "./ir.ts";
export { augment } from "./augment.ts";
export { reconstruct, checkIsomorphic } from "./verify.ts";
export type { CheckResult, ReconstructedCfg } from "./verify.ts";
export { applyStagePasses } from "./passes.ts";
export { printTree } from "./print.ts";

export interface StructureOptions {
  /** §4.4 irreducibility resolution. Default "auto". */
  readonly irreducible?: "auto" | "duplicate" | "dispatch";
  readonly maxExpansion?: number; // default 2.0
  /** D6 tier -1 debug escape hatch: the whole function as one dispatch loop. */
  readonly dispatchFallback?: boolean;
  /** Run the §5 round-trip check inline and throw on failure. Default true. */
  readonly verify?: boolean;
  /** ST-09 / §8's recursion guard. Default 1500. */
  readonly maxDepth?: number;
}

const DISPATCH_VAR: readonly DispatchVar[] = [{ id: 0 }];

export function structure(cfg: FunctionCfg, opts: StructureOptions = {}): StructuredFunction {
  const mode = opts.irreducible ?? "auto";
  const maxExpansion = opts.maxExpansion ?? 2.0;
  const verify = opts.verify ?? true;
  const maxDepth = opts.maxDepth ?? 1500;
  const graph = augment(cfg);
  const diagnostics: Diagnostic[] = [];

  const useDispatch = opts.dispatchFallback === true || mode === "dispatch";
  let core = useDispatch ? dispatchStructure(graph) : null;
  if (core === null) {
    try {
      core = ramsey(graph, { maxExpansion, maxDepth });
    } catch (e) {
      if (e instanceof NeedDispatch && mode === "auto") {
        diagnostics.push({ severity: "warn", code: "W_EXPANSION_CAP", message: `falling back to dispatch mode: ${e.why}`, context: { functionIndex: cfg.functionIndex } });
        core = dispatchStructure(graph);
      } else if (e instanceof NeedDispatch) {
        throw new Hbc2jsError(ErrorCode.E_TOO_COMPLEX, `irreducible region needs dispatch mode but irreducible="${mode}": ${e.why}`, { functionIndex: cfg.functionIndex, section: "structure" });
      } else {
        throw e;
      }
    }
  }

  const usedDispatch = useDispatch || diagnostics.some((d) => d.code === "W_EXPANSION_CAP");
  const nesting = maxNesting(core.root);
  const fn: StructuredFunction = {
    functionIndex: cfg.functionIndex,
    root: core.root,
    labels: core.labels,
    dispatchVars: usedDispatch ? DISPATCH_VAR : [],
    duplicatedBlocks: core.duplicatedBlocks,
    graph,
    diagnostics: [...diagnostics, ...core.diagnostics],
    stats: {
      blocks: graph.blocks.length,
      duplicated: core.duplicatedBlocks.length,
      dispatchVars: usedDispatch ? 1 : 0,
      maxNesting: nesting,
      labels: core.labels.length,
      expansion: graph.blocks.length === 0 ? 1 : core.emitted / graph.blocks.length,
    },
  };

  // ST-09
  if (nesting > 1000) {
    throw new Hbc2jsError(ErrorCode.E_TOO_COMPLEX, `structured tree nesting ${nesting} exceeds 1000`, { functionIndex: cfg.functionIndex, section: "structure" });
  }
  // ST-04
  if (!usedDispatch && graph.reducible && fn.duplicatedBlocks.length > 0) {
    diagnostics.push({ severity: "warn", code: "W_UNEXPECTED_DISPATCH", message: `reducible CFG produced ${fn.duplicatedBlocks.length} duplicated block(s)`, context: { functionIndex: cfg.functionIndex } });
  }

  if (verify) {
    const result = checkIsomorphic(fn, reconstruct(fn));
    if (!result.ok) {
      throw new Hbc2jsError(ErrorCode.E_STRUCTURE_UNSOUND, `function ${cfg.functionIndex}: ${result.reason}${formatEdges(result.missingEdges, "missing")}${formatEdges(result.extraEdges, "extra")}`, {
        functionIndex: cfg.functionIndex,
        section: "structure/verify",
      });
    }
  }
  return fn;
}

function formatEdges(edges: readonly (readonly [number, number])[], what: string): string {
  if (edges.length === 0) return "";
  const shown = edges
    .slice(0, 8)
    .map(([a, b]) => `${a}->${b}`)
    .join(", ");
  return `; ${what}: ${shown}${edges.length > 8 ? ` (+${edges.length - 8})` : ""}`;
}
