// loop-cond matcher — docs/LOWERING-CATALOGUE.md rows 2 (while) and 3 (do-while).
//
// Recognises the three shapes the Ramsey structurer gives a loop whose test is
// a single conditional jump, and refuses everything else:
//
//   head:          loop L { block B; if B { break L } else { Y } … }
//   tail:          loop L { A…; block B; if B { continue L } else { E } }
//   tail-labeled:  loop L { A…; M: { A2…; block B; if B { continue L } else { E } }; T… }
//
// (either polarity of the `if`). `E` is the code the structurer nested inside
// the loop because the loop's only normal exit leads there; the rewrite hoists
// it after the loop, which is what makes `do … while (c)` printable.
import type { Stmt } from "../../structure/ir.ts";
import type { Match, PassContext } from "../types.ts";
import type { BlockId } from "../tree.ts";
import { completesNormally, condInputs, instructionsOf, isBreakTo, isContinueTo, items, usesOf } from "../tree.ts";

export type LoopNode = Stmt & { readonly k: "loop" };
export type IfNode = Stmt & { readonly k: "if" };
export type LabeledNode = Stmt & { readonly k: "labeled" };

export interface LoopSite {
  readonly loop: LoopNode;
  readonly shape: "head" | "tail" | "tail-labeled";
  readonly cond: BlockId;
  /** True when the `if`'s then-branch is the one that leaves the loop. */
  readonly negate: boolean;
  readonly guard: IfNode;
  /** The branch that leaves the loop (`break L` when nothing needs hoisting). */
  readonly exit: Stmt;
  readonly labeled: LabeledNode | null;
  readonly kind: "while" | "do-while";
}

export type LoopMatch = Match<Stmt, LoopSite>;

export function match(node: Stmt, ctx: PassContext): LoopMatch | null {
  if (node.k !== "loop" || node.form !== undefined || ctx.structured === undefined) return null;
  const site = matchHead(node, ctx) ?? matchTail(node, ctx);
  if (site === null) return null;
  const start = ctx.structured.graph.blocks[site.cond]?.block?.start ?? 0;
  return { root: node, nodes: [node, site.guard], data: site, at: { functionIndex: ctx.functionIndex, offset: start } };
}

/** `if B` on `B` with one branch exactly `break L`: the loop test is at the head. */
function matchHead(loop: LoopNode, ctx: PassContext): LoopSite | null {
  const body = items(loop.body);
  const [b, g] = body;
  if (b === undefined || g === undefined || b.k !== "block" || g.k !== "if" || g.cfgBlock !== b.cfgBlock) return null;
  const insns = instructionsOf(ctx.structured!, b.cfgBlock);
  // The head block may hold nothing but the jump: anything else would have to
  // be printed *inside* the condition, which stage A cannot do.
  if (insns === null || insns.length !== 1 || condInputs(insns[0]!) === null) return null;
  const L = loop.label;
  let negate: boolean;
  if (isBreakTo(g.then, L) && !isBreakTo(g.else, L)) negate = true;
  else if (isBreakTo(g.else, L) && !isBreakTo(g.then, L)) negate = false;
  else return null;
  return { loop, shape: "head", cond: b.cfgBlock, negate, guard: g, exit: negate ? g.then : g.else, labeled: null, kind: "while" };
}

/** `block B; if B { continue L } else { E }` as the last statement of the body, or of a labeled block that ends the body's normal path. */
function matchTail(loop: LoopNode, ctx: PassContext): LoopSite | null {
  const fn = ctx.structured!;
  const L = loop.label;
  const body = items(loop.body);
  const last = body[body.length - 1];
  if (last === undefined) return null;

  let guardSeq: readonly Stmt[];
  let labeled: LabeledNode | null = null;
  let trailing: readonly Stmt[] = [];
  if (last.k === "if") {
    guardSeq = body;
  } else {
    // tail-labeled: find the labeled block whose body ends in the guard and
    // after which nothing can complete normally.
    const mi = body.findIndex((s) => s.k === "labeled" && items(s.body).at(-1)?.k === "if");
    if (mi < 0) return null;
    const found = body[mi] as LabeledNode;
    labeled = found;
    guardSeq = items(found.body);
    trailing = body.slice(mi + 1);
    if (trailing.length === 0 || completesNormally({ k: "seq", body: trailing })) return null;
    for (const t of trailing) {
      const u = usesOf(t, L);
      if (u.breaks > 0 || u.continues > 0) return null;
    }
  }
  const g = guardSeq[guardSeq.length - 1];
  const b = guardSeq[guardSeq.length - 2];
  if (g === undefined || b === undefined || g.k !== "if" || b.k !== "block" || g.cfgBlock !== b.cfgBlock) return null;
  const insns = instructionsOf(fn, b.cfgBlock);
  if (insns === null || insns.length === 0) return null;
  const lastInsn = insns[insns.length - 1]!;
  const inputs = condInputs(lastInsn);
  if (inputs === null) return null;

  let negate: boolean;
  if (isContinueTo(g.then, L) && !isContinueTo(g.else, L)) negate = false;
  else if (isContinueTo(g.else, L) && !isContinueTo(g.then, L)) negate = true;
  else return null;
  const exit = negate ? g.then : g.else;
  const exitIsBreak = isBreakTo(exit, L);

  // Everything before the guard: no other back edge (a JS `continue` in a
  // do-while jumps to the test, not the head). Other `break L`s are fine only
  // when nothing is hoisted (they keep their target).
  const M: LabeledNode | null = labeled;
  const before: Stmt[] = M === null ? body.slice(0, -1) : [...body.slice(0, body.indexOf(M)), ...guardSeq.slice(0, -1)];
  for (const s of before) {
    const u = usesOf(s, L);
    if (u.continues > 0) return null;
    if (u.breaks > 0 && !(exitIsBreak && labeled === null)) return null;
  }
  if (!exitIsBreak) {
    const u = usesOf(exit, L);
    if (u.breaks > 0 || u.continues > 0) return null;
    // Hoisted exit code must not fall back into the loop.
    if (labeled === null && completesNormally(exit)) return null;
  }
  // A test at the tail is a `do … while`, always. It may *also* be a rotated
  // `while`/`for` whose statically-true pre-test hermesc folded away, but the
  // two are indistinguishable here: only for-header, which has the init and
  // the step in hand, can prove the first test holds and promote it (spec 07
  // catalogue row 4). Guessing here made fixture 03's genuine `do … while`
  // print as `while` at v96/98/99 and not at v84/94 — version-dependent noise.
  return { loop, shape: labeled === null ? "tail" : "tail-labeled", cond: b.cfgBlock, negate, guard: g, exit, labeled, kind: "do-while" };
}
