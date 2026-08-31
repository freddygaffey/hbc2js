// if-chain matcher — docs/specs/passes/09-if-chain.md §4, catalogue row 1
// (docs/lowering/if-else-chain.md, ✅ verified at 84/94/98/99, zero version
// sensitivity — so `versions` is unset and the rung runs everywhere).
//
// C1 (else-drop, the early-return flatten): every path through the `then` arm
// ends abruptly (`return`/`throw`/`break`/`continue`/`unreachable`), so the
// `else` arm's statements can become the `if`'s following siblings and the
// staircase flattens to a run of guards. C3 (`else if` intent): the `else`
// arm is exactly a chain link — `[if]`, or `[block bX, if bX]` where the same
// block computes the condition and branches on it — so the node gets the
// `elseIf` annotation and the *printer* decides whether it ends up printable
// as `else if` once stage B has folded the condition block (§5). C1 is tried
// first: a flattened chain beats an `else if` chain, and where C1 refuses C3
// is exactly the residue worth marking. The spec's C2 hygiene rule is dropped
// as it recommends: the C1 writer emits the canonical empty `seq` directly.
//
// Refusals (spec §7) are match-time `null`s — the framework's "refuse
// generously, a refused site costs nothing" convention:
//  * `no-else` / `then-falls-through` / `empty-then-needs-negation` — C1's
//    preconditions. There is no `if.negate` field, so the empty-`then` shape
//    `if (c) { } else { E }` cannot be normalised here (spec §8 question 1:
//    a possible separate `if-negate` rung with its own round-trip evidence).
//  * `loop-test` — the `if` is some enclosing loop's annotated test
//    (`LoopForm.cond`, either `at` position); flattening it would move the
//    loop body out of the arm `LoopForm.at` names and the emitter would
//    silently fall back to `while (true)`.
//  * `generator-dispatcher` — the function's root contains a resume/dispatch
//    `switch`; refuse the whole function until batch 4's generator rungs run
//    (same rule as spec 06 §7).
//  * `switch-arm-spine` ships disabled-by-default behind the presence of a
//    `switch-raise` registration (spec §7/§8 question 2). `switch-raise` is
//    now registered (before this rung), but only its S1 (jump-table) rule —
//    S2 (compare-chain) is blocked on F13 and matches nothing (spec 10 §4),
//    so there is still no S2a chain predicate to key this refusal on; it
//    stays deliberately unimplemented until S2 lands.
import type { Stmt } from "../../structure/ir.ts";
import type { Match, PassContext } from "../types.ts";
import { completesNormally, items } from "../tree.ts";
import { postOrder } from "../driver.ts";

export type IfNode = Stmt & { readonly k: "if" };

export interface ChainSite {
  readonly rule: "C1" | "C3";
  /** The `else` arm's items. C1's writer splices them after the `if`; the
   *  checker re-derives them from `before` and never trusts this capture. */
  readonly elseItems: readonly Stmt[];
}

export type ChainMatch = Match<Stmt, ChainSite>;

export function match(node: Stmt, ctx: PassContext): ChainMatch | null {
  // `elseIf === true` is the idempotence latch (PL-08): C3's own output, and
  // C1 must not undo it either.
  if (node.k !== "if" || node.elseIf === true) return null;
  if (isLoopTest(node, ctx)) return null;
  if (isGeneratorDispatcher(ctx)) return null;
  const site = matchC1(node) ?? matchC3(node);
  if (site === null) return null;
  const start = ctx.structured?.graph.blocks[node.cfgBlock]?.block?.start ?? 0;
  return { root: node, nodes: [node], data: site, at: { functionIndex: ctx.functionIndex, offset: start } };
}

/** §4 C1 — else-drop. */
function matchC1(node: IfNode): ChainSite | null {
  const elseItems = items(node.else);
  if (elseItems.length === 0) return null; // no-else
  if (items(node.then).length === 0) return null; // empty-then-needs-negation (implied by the next line; asserted, not relied on)
  if (completesNormally(node.then)) return null; // then-falls-through
  return { rule: "C1", elseItems };
}

/** §4 C3 — `else if` intent (annotation only). */
function matchC3(node: IfNode): ChainSite | null {
  const e = items(node.else);
  return chainLink(e) === null ? null : { rule: "C3", elseItems: e };
}

/**
 * §4 C3's shape predicate, shared with the checker: `[if]`, or
 * `[block bX, if bX]`. The `cfgBlock` equality is the whole check — two
 * different blocks would mean the `else` arm does real work before branching,
 * and printing `else if` would then have to swallow that work.
 */
export function chainLink(e: readonly Stmt[]): IfNode | null {
  if (e.length === 1 && e[0]!.k === "if") return e[0] as IfNode;
  if (e.length === 2 && e[0]!.k === "block" && e[1]!.k === "if" && e[0]!.cfgBlock === e[1]!.cfgBlock) return e[1] as IfNode;
  return null;
}

/** `loop-test`: is `node` the annotated test of any enclosing formed loop? */
function isLoopTest(node: IfNode, ctx: PassContext): boolean {
  if (ctx.parentOf !== undefined) {
    for (let p = ctx.parentOf(node); p !== null; p = ctx.parentOf(p.parent)) {
      const s = p.parent as Stmt;
      if (s.k === "loop" && s.form !== undefined && s.form.cond === node.cfgBlock) return true;
    }
    return false;
  }
  // Unit tests may supply no parent lookup; scan the whole tree instead
  // (conservative: any formed loop naming this block refuses).
  const root = ctx.structured?.root;
  if (root === undefined) return false;
  return postOrder(root).some((n) => n.k === "loop" && n.form !== undefined && n.form.cond === node.cfgBlock);
}

/** `generator-dispatcher`, memoised per tree root (match runs on every node). */
const dispatcherCache = new WeakMap<Stmt, boolean>();
function isGeneratorDispatcher(ctx: PassContext): boolean {
  const root = ctx.structured?.root;
  if (root === undefined) return false;
  let v = dispatcherCache.get(root);
  if (v === undefined) {
    v = postOrder(root).some((n) => n.k === "switch" && (n.scrutinee.t === "generator-state" || n.scrutinee.t === "dispatch"));
    dispatcherCache.set(root, v);
  }
  return v;
}
