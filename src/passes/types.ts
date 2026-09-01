// docs/specs/07-pass-ladder.md §2 — the D12 framework contract (matcher + writer
// + checker). No pass exists yet (D11: the M4 baseline comes first); this file is
// what M5's passes implement against, and what src/structure/passes.ts drives.
import type { Diagnostic } from "../errors.ts";
import type { FunctionCfg, ModuleAnalysis } from "../cfg/types.ts";
import type { LayoutClass } from "../parse/types.ts";
import type { StructuredFunction } from "../structure/ir.ts";
import type { Stmt as AstStmt } from "../emit/ast.ts";
import type { ModuleView } from "./tree.ts";

/** Stage A operates on the structurer's tree IR; stage B on the JS AST. */
export type Stage = "A" | "B";

export interface PassContext {
  readonly analysis: ModuleAnalysis;
  readonly functionIndex: number;
  readonly cfg: FunctionCfg;
  readonly hbcVersion: number;
  readonly layoutClass: LayoutClass;
  /** Passes already applied to this function, in order. */
  readonly applied: readonly string[];
  readonly diagnostic: (d: Diagnostic) => void;
  /**
   * Stage A only: the function the tree belongs to (labels, duplicated blocks,
   * the augmented graph) and a parent lookup for the *current* tree, so a
   * matcher can see the statement that precedes its node (for-header needs the
   * block that falls into a loop). Both are absent for stage B.
   */
  readonly structured?: StructuredFunction;
  readonly parentOf?: (node: unknown) => { readonly parent: unknown; readonly index: number } | null;
  /**
   * F6: a read-only whole-module view, built once per module. Present for
   * both stages. By convention (not enforced) only the naming rungs and
   * `jsx-recover` read it.
   */
  readonly module?: ModuleView;
  /**
   * F1: stage B only — the *current* whole function body, re-derived after
   * every accepted site, so a rung can ask a whole-function question
   * (liveness, free names) from one statement list.
   */
  readonly fnBody?: readonly AstStmt[];
}

export interface Match<TNode, TData = unknown> {
  readonly root: TNode;
  readonly nodes: readonly TNode[];
  readonly data: TData;
  readonly at: { readonly functionIndex: number; readonly offset: number };
}

export interface CheckResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface Pass<TNode = unknown, TData = unknown> {
  readonly name: string; // kebab-case, matches the directory
  readonly stage: Stage;
  readonly targets: readonly string[];
  /**
   * PL-06: the `docs/LOWERING-CATALOGUE.md` rows whose idiom this pass
   * recognises — a numbered `#` index row, or (spec
   * `docs/specs/passes/01-framework-fixes.md` F2) an `R`-prefixed readability
   * row for a rung that recognises no Hermes idiom at all.
   * tests/gate/passes/catalogue.test.ts reads the catalogue's status column
   * and fails if any row here is ⛔ or missing, for either kind of key.
   */
  readonly catalogue: readonly (number | string)[];
  /** Pure. Recognises one Hermes lowering idiom. MUST NOT mutate. */
  match(node: TNode, ctx: PassContext): Match<TNode, TData> | null;
  /** Pure. Emits the idiomatic form for exactly the captured shape. */
  rewrite(m: Match<TNode, TData>, ctx: PassContext): TNode;
  /** Local guard: entry/exit edges (stage A) or effect sequence (stage B). */
  check(before: TNode, after: TNode, ctx: PassContext): CheckResult;
  readonly after?: readonly string[];
  readonly before?: readonly string[];
  /**
   * F7: restrict a rung to bytecode versions/layouts it has actually been
   * measured against. Applied by `runPasses` (stage A) and `astPassHook`
   * (stage B) when the pass list is built *for a module* (they have a
   * version in hand; `enabledPasses` does not). A filtered-out rung is
   * reported once per module as `W_PASS_VERSION_SKIP`.
   */
  readonly versions?: (hbcVersion: number, layoutClass: LayoutClass) => boolean;
  /**
   * D20 / docs/specs/passes/08-jsx-recovery.md §7: a rung that is registered
   * (ordered, catalogued, tested like any other) but **not** part of the
   * default pipeline — `enabledPasses` drops it unless `optIn` names it
   * (`--jsx`). The equivalence gate runs the default pipeline, so an opt-in
   * rung's output is never what the trace oracle executes.
   */
  readonly optIn?: boolean;
}

export interface AppliedRecord {
  readonly pass: string;
  readonly at: { readonly functionIndex: number; readonly offset: number };
}

export interface AbandonedRecord extends AppliedRecord {
  readonly reason: string;
}
