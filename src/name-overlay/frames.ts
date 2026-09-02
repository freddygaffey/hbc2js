// Raw per-frame bodies — the JS AST each function's `emitFunction` produced,
// with registers still `rN`, captured at the stage-B (`astPasses`) entry BEFORE
// var-naming renames anything. This is the exact body the overlay keys onto
// (`{fn,reg}` ⇒ ident `rN`) and the body the reuse gate classifies
// (`classifySite`, which expects raw register names). Shared by `gate.ts` and
// tests; `render.ts` runs its own overlay-then-var-naming pass instead.

import type { ModuleAnalysis } from "../cfg/types.ts";
import type { Stmt } from "../emit/ast.ts";
import { emitModule } from "../emit/index.ts";
import { passHook } from "../passes/index.ts";
import type { PassPipelineOptions } from "../passes/index.ts";

/** Map from Hermes function index to its raw `k:"func"` body statements. A
 *  function that stubbed or emitted as a non-func is absent. `strictEnv` mirrors
 *  the decompile default so the same functions resolve. */
export function rawFrameBodies(analysis: ModuleAnalysis, opts: { readonly passes?: PassPipelineOptions; readonly strictEnv?: boolean } = {}): Map<number, readonly Stmt[]> {
  const bodies = new Map<number, readonly Stmt[]>();
  const strictEnv = opts.strictEnv ?? true;
  emitModule(analysis, {
    provenanceComments: false,
    strictEnv,
    passes: passHook(analysis, opts.passes),
    // Identity stage-B hook: capture the raw body, apply nothing.
    astPasses: (fn, cfg) => {
      if (fn.k === "func") bodies.set(cfg.functionIndex, fn.body);
      return { fn, diagnostics: [] };
    },
  });
  return bodies;
}
