// label-clean matcher — docs/specs/passes/06-label-clean.md §4, catalogue row R8.
//
// Four independent rules, dispatched by node kind (a node has exactly one
// `k`, so at most one rule can ever apply to it):
//
//   L1 — `labeled` nothing breaks or continues to: unwrap.
//   L2 — `labeled` whose only uses are `break L` in tail position: unwrap,
//        deleting those breaks (they were already equivalent to falling off
//        the end).
//   L3 — a `loop` whose label, at every use, is the innermost construct an
//        unlabelled jump would reach anyway: hide the label (annotation
//        only — the label can never be deleted, `break`/`continue` require
//        a `LabelId`).
//   L4 — a one-element `seq`: unwrap.
//
// Per-function refusal: a body containing a generator/async resume
// dispatcher (`switch` on a `generator-state`/`dispatch` scrutinee) is left
// alone entirely until batch 4's generator rungs have run first (§7).
import { children } from "../../structure/ir.ts";
import type { LabelId, Stmt } from "../../structure/ir.ts";
import type { Match, PassContext } from "../types.ts";
import { blocksOf, usesOf } from "../tree.ts";

export type LabeledNode = Stmt & { readonly k: "labeled" };
export type LoopNode = Stmt & { readonly k: "loop" };
export type SeqNode = Stmt & { readonly k: "seq" };

export type LabelSite = { readonly rule: "L1" | "L2"; readonly node: LabeledNode } | { readonly rule: "L3"; readonly node: LoopNode } | { readonly rule: "L4"; readonly node: SeqNode };

export type LabelMatch = Match<Stmt, LabelSite>;

export function match(node: Stmt, ctx: PassContext): LabelMatch | null {
  if (ctx.structured !== undefined && hasGeneratorDispatch(ctx.structured.root)) return null; // generator-dispatcher
  if (node.k === "labeled") return matchLabeled(node, ctx);
  if (node.k === "loop") return matchLoop(node, ctx);
  if (node.k === "seq" && node.body.length === 1) return makeMatch(node, { rule: "L4", node }, ctx);
  return null;
}

function matchLabeled(node: LabeledNode, ctx: PassContext): LabelMatch | null {
  const u = usesOf(node.body, node.label);
  if (u.breaks === 0 && u.continues === 0) return makeMatch(node, { rule: "L1", node }, ctx); // L1
  if (u.continues > 0) return null; // a continue to this label can never be a tail break
  const tail = tailSet(node.body);
  let tailForLabel = 0;
  for (const n of tail) if (n.k === "break" && n.label === node.label) tailForLabel++;
  if (tailForLabel !== u.breaks) return null; // break-not-in-tail
  return makeMatch(node, { rule: "L2", node }, ctx);
}

function matchLoop(node: LoopNode, ctx: PassContext): LabelMatch | null {
  if (node.hideLabel === true) return null; // already hidden (PL-08 fixed point)
  const r = checkInnermostTargets(node);
  if (!r.ok) return null; // label-still-needed / continue-to-labeled-block
  return makeMatch(node, { rule: "L3", node }, ctx);
}

function makeMatch(node: Stmt, data: LabelSite, ctx: PassContext): LabelMatch {
  return { root: node, nodes: [node], data, at: { functionIndex: ctx.functionIndex, offset: siteOffset(node, ctx) } };
}

function siteOffset(node: Stmt, ctx: PassContext): number {
  if (ctx.structured === undefined) return 0;
  const first = blocksOf(node)[0];
  if (first === undefined) return 0;
  return ctx.structured.graph.blocks[first]?.block?.start ?? 0;
}

/**
 * §4's tail set: the `break` statements a `seq`/`if` spine reaches without
 * passing through another `loop`/`labeled` (which are opaque — a break out
 * of an inner construct is not a tail of this one). Everything else
 * (`block`, `return`, `throw`, `continue`, `switch`, `try`, `setState`,
 * `unreachable`) contributes nothing, by the same opacity rule.
 */
export function tailSet(node: Stmt): ReadonlySet<Stmt> {
  switch (node.k) {
    case "seq": {
      const last = node.body[node.body.length - 1];
      return last === undefined ? new Set() : tailSet(last);
    }
    case "if":
      return new Set([...tailSet(node.then), ...tailSet(node.else)]);
    case "break":
      return new Set([node]);
    default:
      return new Set();
  }
}

/**
 * L2's writer/checker, shared so `rewrite.ts` and `check.ts` cannot drift:
 * delete every `break label` reachable through the `seq`/`if` spine (the
 * exact set `tailSet` computes), leaving `{k:"seq", body:[]}` in its place.
 * Reference-preserving: a subtree untouched by the deletion comes back by
 * identity, so calling this with zero matching breaks (L1) returns `node`
 * itself unchanged, exactly as the L1 writer wants.
 */
export function deleteTailBreaks(node: Stmt, label: LabelId): Stmt {
  switch (node.k) {
    case "seq": {
      if (node.body.length === 0) return node;
      const last = node.body[node.body.length - 1]!;
      const newLast = deleteTailBreaks(last, label);
      return newLast === last ? node : { k: "seq", body: [...node.body.slice(0, -1), newLast] };
    }
    case "if": {
      const then = deleteTailBreaks(node.then, label);
      const els = deleteTailBreaks(node.else, label);
      return then === node.then && els === node.else ? node : { ...node, then, else: els };
    }
    case "break":
      return node.label === label ? { k: "seq", body: [] } : node;
    default:
      return node;
  }
}

/** Structural equality over exactly the shapes `deleteTailBreaks` can
 *  produce (`seq`/`if`/`break`); anything else must be the same object. */
export function stmtEqual(a: Stmt, b: Stmt): boolean {
  if (a === b) return true;
  if (a.k !== b.k) return false;
  if (a.k === "seq" && b.k === "seq") return a.body.length === b.body.length && a.body.every((s, i) => stmtEqual(s, b.body[i]!));
  if (a.k === "if" && b.k === "if") return a.cfgBlock === b.cfgBlock && stmtEqual(a.then, b.then) && stmtEqual(a.else, b.else);
  if (a.k === "break" && b.k === "break") return a.label === b.label;
  return false;
}

export interface InnermostResult {
  readonly ok: boolean;
  readonly reason?: "label-still-needed" | "continue-to-labeled-block";
}

interface Frame {
  readonly label: LabelId;
  readonly kind: "loop" | "labeled";
}

/**
 * §4 L3 / §6 obligation 4: one lexical walk of `loop.body` carrying a stack
 * of enclosing loop/labeled labels. A `break loop.label` must find
 * `loop.label` at the *top* of the stack (the innermost enclosing construct
 * of either kind); a `continue loop.label` must find it at the nearest
 * `"loop"`-kind frame (a `labeled` block cannot receive an unlabelled
 * `continue`). Also guards against the structurer ever having emitted a
 * `continue` whose label resolves to a `labeled` block — invalid JS, so this
 * refuses rather than assumes.
 */
export function checkInnermostTargets(loop: LoopNode): InnermostResult {
  let bad: InnermostResult | null = null;
  const visit = (node: Stmt, stack: readonly Frame[]): void => {
    if (bad !== null) return;
    switch (node.k) {
      case "break":
        if (node.label === loop.label) {
          const top = stack[stack.length - 1];
          if (top === undefined || top.label !== loop.label) bad = { ok: false, reason: "label-still-needed" };
        }
        return;
      case "continue": {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i]!.label === node.label) {
            if (stack[i]!.kind === "labeled") bad = { ok: false, reason: "continue-to-labeled-block" };
            break;
          }
        }
        if (bad !== null) return;
        if (node.label === loop.label) {
          let nearestLoop: Frame | undefined;
          for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i]!.kind === "loop") {
              nearestLoop = stack[i];
              break;
            }
          }
          if (nearestLoop === undefined || nearestLoop.label !== loop.label) bad = { ok: false, reason: "label-still-needed" };
        }
        return;
      }
      case "loop":
        visit(node.body, [...stack, { label: node.label, kind: "loop" }]);
        return;
      case "labeled":
        visit(node.body, [...stack, { label: node.label, kind: "labeled" }]);
        return;
      default:
        for (const c of children(node)) visit(c, stack);
    }
  };
  visit(loop.body, [{ label: loop.label, kind: "loop" }]);
  return bad ?? { ok: true };
}

function hasGeneratorDispatch(root: Stmt): boolean {
  const stack: Stmt[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.k === "switch" && (n.scrutinee.t === "generator-state" || n.scrutinee.t === "dispatch")) return true;
    stack.push(...children(n));
  }
  return false;
}
