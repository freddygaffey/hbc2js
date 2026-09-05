// for-of matcher — docs/specs/passes/21-for-in-for-of.md §4.2, catalogue row 10.
//
// The measured shape (§2.2), modulo the v99 register-plumbing deltas §7
// records (a `Mov` refreshing `IteratorNext`'s source, aliasing the
// destination register; a `Mov` before a normal `IteratorClose`):
//
//   block bS               ; [Mov ;] IteratorBegin state, src
//   loop L {
//     block bH             ; [Mov s', src ;] IteratorNext v, state, s' ; Mov t, state ; <cmp> t, u
//     if bH { <exit> } else { <continuation, or a flat sibling holds it> }
//   }
//
// where `<continuation>` is `try rC { block bB…; continue L } catch rX
// { Catch rX; IteratorClose state, 1; Throw rX }`. The Ramsey structurer
// normally sinks the continuation into whichever arm of the header `if`
// is not the exit (real fixtures); the loop rungs' own synthetic tests use
// a flatter shape (the `try` a plain sibling after the `if`) — both are
// accepted, mirroring `WhileForm`'s existing "head" handling in
// `src/emit/function.ts`.
import type { Instruction } from "../tree.ts";
import type { IterForm, Stmt, StructuredFunction } from "../../structure/ir.ts";
import type { Match, PassContext } from "../types.ts";
import { instructionsOf, items, precedingSibling, registerLiveAfter, usesOf } from "../tree.ts";

export type LoopNode = Stmt & { readonly k: "loop" };
export type IfNode = Stmt & { readonly k: "if" };
export type TryNode = Stmt & { readonly k: "try" };

export interface ForOfSite {
  readonly loop: LoopNode;
  readonly form: IterForm;
}

export type ForOfMatch = Match<Stmt, ForOfSite>;

export function match(node: Stmt, ctx: PassContext): ForOfMatch | null {
  if (node.k !== "loop" || node.form !== undefined) return null; // P0
  const fn = ctx.structured;
  if (fn === undefined) return null; // P1
  if (usesOf(node.body, node.label).continues !== 1) return null; // P2

  // With a source `break` (fixture 06's first loop), the structurer wraps
  // the header in a `labeled` block so the exhaustion exit and the source
  // `break` share a target distinct from the loop's own `continue` (spec 21
  // sec2.2; mirrored at print time in src/emit/function.ts's `lowerIterLoop`).
  const rawItems = items(node.body);
  let body = rawItems;
  if (rawItems[0]?.k === "labeled") {
    const inner = items(rawItems[0].body);
    if (inner.length === 2 && inner[0]?.k === "block" && inner[1]?.k === "if" && inner[1].cfgBlock === inner[0].cfgBlock) body = inner;
  }
  if (body.length < 2 || body[0]!.k !== "block" || body[1]!.k !== "if") return null;
  const bH = body[0]!.cfgBlock;
  const guard = body[1] as IfNode;
  if (guard.cfgBlock !== bH) return null;

  const header = parseHeader(fn, bH);
  if (header === null) return null; // P3
  const { v, state, srcInHeader } = header;

  // Locate the `try` (P4.2's abrupt-close companion): either nested as the
  // sole content of one arm of `guard`, or a flat sibling after it.
  const located = locateTry(guard, body.slice(2), node.label);
  if (located === null) return null;
  const { tryNode, negate } = located;
  if (tryNode.k !== "try") return null;

  // P4: setup — the loop's own flat preceding sibling ends in `IteratorBegin`.
  const setupStmt = precedingSibling(ctx, node);
  if (setupStmt === null || setupStmt.k !== "block") return null;
  const setupInsns = instructionsOf(fn, setupStmt.cfgBlock);
  if (setupInsns === null || setupInsns.length === 0) return null;
  const begin = setupInsns[setupInsns.length - 1]!;
  if (begin.name !== "IteratorBegin") return null;
  const beginState = regOperand(begin, 0);
  const beginSrc = regOperand(begin, 1);
  if (beginState === undefined || beginSrc === undefined || beginState !== state || beginSrc !== srcInHeader) return null;

  // P5: the abrupt close — `Catch rX; IteratorClose state, 1; Throw rX`, exactly.
  const handler = tryNode.handler;
  const handlerBlock = handlerCfgBlock(handler);
  if (handlerBlock === null) return null;
  const hInsns = instructionsOf(fn, handlerBlock);
  if (hInsns === null || hInsns.length !== 3) return null;
  const [catchInsn, closeInsn, throwInsn] = hInsns as readonly [Instruction, Instruction, Instruction];
  if (catchInsn.name !== "Catch" || closeInsn.name !== "IteratorClose" || throwInsn.name !== "Throw") return null;
  const catchReg = regOperand(catchInsn, 0);
  const closeReg = regOperand(closeInsn, 0);
  const throwReg = regOperand(throwInsn, 0);
  if (catchReg === undefined || closeReg !== state || throwReg !== catchReg) return null;
  if (closeInsn.operands[1]?.value !== 1) return null;

  // P6: every other `IteratorClose` on `state` must be a normal close
  // (arg 0), the last instruction of a block (mod trailing `Mov`s already
  // resolved) immediately followed by a `break`. Collected via a scan of the
  // try's own body (the only place the measured shape puts one).
  const normalCloses = findNormalCloses(fn, tryNode.body, state);
  if (normalCloses === null) return null;

  // P7/P8: liveness at every normal exit. `form.binding` (and what prints
  // as the loop's own `left`) stays `v` — `IteratorNext`'s own destination,
  // what every measured fixture's body actually reuses — but a per-iteration
  // `Mov v -> body-register` some sites add on top (§2.2) is what the source
  // program's *real* binding is, so P8's liveness question is asked of that
  // register, not of `v` itself (which the exit path may go on using for
  // something else entirely, e.g. a `return` of the last value — not a
  // leak of the *loop's* binding).
  const livenessBinding = bodyBindingReg(fn, tryNode.body, v);
  const exit = fn.graph.cfg.blocks[bH]?.succs.find((s) => s.kind === "branch-taken")?.to;
  if (exit === undefined) return null;
  if (registerLiveAfter(fn, exit, 0, state)) return null;
  if (registerLiveAfter(fn, exit, 0, livenessBinding)) return null;
  for (const c of normalCloses) if (registerLiveAfter(fn, c, 0, state)) return null;

  const close = [...normalCloses, handlerBlock];
  const form: IterForm = { kind: "for-of", cond: bH, at: "head", negate, iter: bH, setup: setupStmt.cfgBlock, close, binding: v, source: srcInHeader };
  const start = fn.graph.blocks[bH]?.block?.start ?? 0;
  return { root: node, nodes: [node, guard, tryNode], data: { loop: node, form }, at: { functionIndex: ctx.functionIndex, offset: start } };
}

/** The first block of `body`'s own leading `Mov <dst>, v`, if any (§2.2's
 *  `Mov r6, r11 ; v = value`) — the register the source program's binding
 *  actually is, for P8's liveness question only; `v` itself when there is
 *  no such `Mov` (`form.binding` and the emitter both keep using `v`
 *  either way — see the call site's comment). */
function bodyBindingReg(fn: StructuredFunction, body: Stmt, v: number): number {
  const first = items(body)[0];
  if (first === undefined || first.k !== "block") return v;
  const insns = instructionsOf(fn, first.cfgBlock);
  const mov = insns?.[0];
  if (mov === undefined || mov.name !== "Mov" || regOperand(mov, 1) !== v) return v;
  return regOperand(mov, 0) ?? v;
}

function regOperand(insn: Instruction, i: number): number | undefined {
  const op = insn.operands[i];
  return op?.role === "reg" ? op.value : undefined;
}

interface Header {
  readonly v: number;
  readonly state: number;
  readonly srcInHeader: number;
}

/** `[Mov s', src ;] IteratorNext v, state, s' ; Mov t, state ; <cmp> t, u` (§2.2, §7a). */
function parseHeader(fn: StructuredFunction, block: number): Header | null {
  const insns = instructionsOf(fn, block);
  if (insns === null) return null;
  let i = insns.findIndex((x) => x.name === "IteratorNext");
  if (i < 0 || i + 2 >= insns.length) return null;
  const next = insns[i]!;
  const v = regOperand(next, 0);
  const state = regOperand(next, 1);
  const nextSrc = regOperand(next, 2);
  if (v === undefined || state === undefined || nextSrc === undefined) return null;
  let srcInHeader = nextSrc;
  if (i > 0) {
    const pre = insns[i - 1]!;
    if (pre.name === "Mov" && regOperand(pre, 0) === nextSrc) {
      const resolved = regOperand(pre, 1);
      if (resolved === undefined) return null;
      srcInHeader = resolved;
    }
  }
  const movT = insns[i + 1]!;
  if (movT.name !== "Mov" || regOperand(movT, 1) !== state) return null;
  const t = regOperand(movT, 0);
  const cmp = insns[i + 2]!;
  if (t === undefined || !/^JStrict(Equal|NotEqual)/.test(cmp.name)) return null;
  const cmpRegs = cmp.operands.filter((o) => o.role === "reg").map((o) => o.value);
  if (!cmpRegs.includes(t)) return null;
  return { v, state, srcInHeader };
}

/** Finds the `try` continuing the loop, nested in one arm of `guard` or a flat sibling. */
function locateTry(guard: IfNode, flatRest: readonly Stmt[], loopLabel: number): { readonly tryNode: Stmt; readonly negate: boolean } | null {
  const thenItems = items(guard.then);
  const elseItems = items(guard.else);
  const thenTry = thenItems.find((s) => s.k === "try" && endsWithContinue(s, loopLabel));
  const elseTry = elseItems.find((s) => s.k === "try" && endsWithContinue(s, loopLabel));
  if (thenTry !== undefined && elseTry === undefined) return { tryNode: thenTry, negate: false };
  if (elseTry !== undefined && thenTry === undefined) return { tryNode: elseTry, negate: true };
  if (thenTry !== undefined && elseTry !== undefined) return null; // ambiguous
  const flatTry = flatRest.find((s) => s.k === "try" && endsWithContinue(s, loopLabel));
  if (flatTry === undefined) return null;
  // Neither arm holds it: whichever arm is non-empty is the exit.
  if (thenItems.length > 0 && elseItems.length === 0) return { tryNode: flatTry, negate: false };
  if (elseItems.length > 0 && thenItems.length === 0) return { tryNode: flatTry, negate: true };
  return null;
}

function endsWithContinue(s: Stmt, label: number): boolean {
  // Not literally the try body's last statement: a source `break` inside
  // the per-iteration body (fixture 06's first loop) puts the loop's own
  // `continue` behind a nested `if` (the break-condition test) instead —
  // P2 already proved exactly one `continue` to this label exists anywhere
  // in the loop, so "reachable inside this try's body at all" is the real
  // test, not "is the try's tail".
  return s.k === "try" && usesOf(s.body, label).continues >= 1;
}

function handlerCfgBlock(handler: Stmt): number | null {
  const it = items(handler);
  if (it.length !== 1) return null;
  const h = it[0]!;
  return "cfgBlock" in h ? (h.cfgBlock as number) : null;
}

/**
 * Every `IteratorClose state, 0` reachable in `body`, as the last (non-`Mov`)
 * instruction of its block, immediately followed by a `break` (§4.2 P6).
 * `null` on any close that doesn't fit — refuse the whole site.
 */
function findNormalCloses(fn: StructuredFunction, body: Stmt, state: number): readonly number[] | null {
  const out: number[] = [];
  const top = items(body);
  for (const [i, s] of top.entries()) {
    if (!visitDeep(s, top, i, fn, state, out)) return null;
  }
  return out;
}

/** Depth-first, but tracks each statement's own sibling list so "immediately followed by a break" is checked in the right list. */
function visitDeep(s: Stmt, siblings: readonly Stmt[], index: number, fn: StructuredFunction, state: number, out: number[]): boolean {
  if (s.k === "block") {
    const insns = instructionsOf(fn, s.cfgBlock);
    if (insns === null || insns.length === 0) return true;
    const li = insns[insns.length - 1]!;
    if (li.name !== "IteratorClose") return true;
    const reg = li.operands[0]?.role === "reg" ? li.operands[0].value : undefined;
    if (reg !== state) return true; // not this loop's iterator state — not this rung's concern
    if (li.operands[1]?.value !== 0) return false; // an unexpected abrupt close outside the handler
    const next = siblings[index + 1];
    if (next === undefined || next.k !== "break") return false;
    out.push(s.cfgBlock);
    return true;
  }
  if (s.k === "if") {
    const thenItems = items(s.then);
    const elseItems = items(s.else);
    return thenItems.every((c, i) => visitDeep(c, thenItems, i, fn, state, out)) && elseItems.every((c, i) => visitDeep(c, elseItems, i, fn, state, out));
  }
  if (s.k === "labeled" || s.k === "loop") {
    const inner = items(s.body);
    return inner.every((c, i) => visitDeep(c, inner, i, fn, state, out));
  }
  return true;
}

export type { Instruction };
