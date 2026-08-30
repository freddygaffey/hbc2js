// docs/specs/00-project-skeleton.md §2.1 — D11/D12 pass shape. No pass exists yet
// (M1/M2 scaffolding only); this file is what M4+ passes implement against.

/** Whatever a pass's `match` recognises. Passes define their own concrete shape;
 *  this is the structural floor every Match must satisfy. */
export interface Match {
  readonly kind: string;
}

/** Shared context every pass receives; grown as M4 needs it (symbol tables, CFG
 *  handles, etc.) — empty for now, deliberately. */
export interface PassContext {
  readonly passName: string;
}

export interface Pass<M extends Match = Match> {
  readonly name: string;
  /** Recognises one Hermes lowering idiom. Pure — never mutates `node`. */
  match(node: unknown, ctx: PassContext): M | null;
  /** Emits idiomatic JS for exactly the captured shape. */
  rewrite(match: M): unknown;
  /** Asserts the rewritten subtree preserves control-flow entry/exit edges. On
   *  failure the pass is abandoned for that site; the correct-but-ugly form survives. */
  check(before: unknown, after: unknown): boolean;
}
