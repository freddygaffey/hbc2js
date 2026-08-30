// docs/specs/07-pass-ladder.md §2 — the D12 framework contract (matcher + writer
// + checker). No pass exists yet (D11: the M4 baseline comes first); this file is
// what M5's passes implement against, and what src/structure/passes.ts drives.
import type { Diagnostic } from "../errors.ts";
import type { FunctionCfg, ModuleAnalysis } from "../cfg/types.ts";
import type { LayoutClass } from "../parse/types.ts";

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
  /** Pure. Recognises one Hermes lowering idiom. MUST NOT mutate. */
  match(node: TNode, ctx: PassContext): Match<TNode, TData> | null;
  /** Pure. Emits the idiomatic form for exactly the captured shape. */
  rewrite(m: Match<TNode, TData>, ctx: PassContext): TNode;
  /** Local guard: entry/exit edges (stage A) or effect sequence (stage B). */
  check(before: TNode, after: TNode, ctx: PassContext): CheckResult;
  readonly after?: readonly string[];
  readonly before?: readonly string[];
}

export interface AppliedRecord {
  readonly pass: string;
  readonly at: { readonly functionIndex: number; readonly offset: number };
}

export interface AbandonedRecord extends AppliedRecord {
  readonly reason: string;
}
