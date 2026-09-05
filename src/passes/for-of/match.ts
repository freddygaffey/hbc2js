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

  // Locate the `try` (P4.2's abrupt-close companion): nested in one arm of
  // `guard`, a flat sibling after it, or (v84/v94/v96 with a source `break`,
  // docs/BUGS.md `for-of-break-handler-shape`) inside a `labeled` merge-point
  // wrapper whose following sibling holds the shared cleanup handler.
  const located = locateTry(guard, body.slice(2), node.label);
  if (located === null) return null;
  const { tryNode, negate, mergeLabel, mergeHandler } = located;
  if (tryNode.k !== "try") return null;

  // P4: setup — the loop's own flat preceding sibling holds `IteratorBegin
  // state, src`. Measured at v84/v94 as the block's *last* instruction, but
  // v96/v98/v99 schedule the body's own constant loads after it
  // (`IteratorBegin r4,r6 ; LoadConstUInt8 r5,30`, 06-for-of-array), so the
  // requirement is only that nothing between the `IteratorBegin` and the loop
  // touches either register the loop reads — which is what "nothing between
  // the IteratorBegin and the loop" was measuring in the first place.
  const setupStmt = precedingSibling(ctx, node);
  if (setupStmt === null || setupStmt.k !== "block") return null;
  const setupInsns = instructionsOf(fn, setupStmt.cfgBlock);
  if (setupInsns === null || setupInsns.length === 0) return null;
  const beginIdx = setupInsns.findLastIndex((x) => x.name === "IteratorBegin" && regOperand(x, 0) === state && regOperand(x, 1) === srcInHeader);
  if (beginIdx < 0) return null;
  for (const x of setupInsns.slice(beginIdx + 1)) {
    if (x.operands.some((o) => o.role === "reg" && (o.value === state || o.value === srcInHeader))) return null;
  }

  // P5: the abrupt close — `Catch rX; IteratorClose state, 1; Throw rX`, exactly.
  const handlerBlock = resolveHandlerBlock(tryNode as TryNode, mergeLabel, mergeHandler);
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
  const normalCloses = findNormalCloses(fn, tryNode.body, state, (t) => resolveHandlerBlock(t, mergeLabel, mergeHandler) === handlerBlock);
  if (normalCloses === null) return null;

  // P7/P8: liveness at every normal exit. The question is asked of exactly
  // the two registers the annotation names — `state` (which the rung is
  // deleting the reads and writes of) and `binding` = `v`, `IteratorNext`'s
  // own destination, which is what the emitter prints as the loop's `left`
  // and therefore what a `const` declaration would scope to the loop. §6's
  // checker restates both on `form.binding`/`form.close`, so asking them of
  // any other register here would let a site through that `check` then
  // refuses (the v94/v96 `07-for-of-iterable` abandonment).
  const exit = fn.graph.cfg.blocks[bH]?.succs.find((s) => s.kind === "branch-taken")?.to;
  if (exit === undefined) return null;
  if (registerLiveAfter(fn, exit, 0, state)) return null;
  if (registerLiveAfter(fn, exit, 0, v)) return null;
  for (const c of normalCloses) {
    const insns = instructionsOf(fn, c);
    const at = insns === null ? -1 : insns.findIndex((x) => x.name === "IteratorClose");
    if (insns === null || at < 0) return null;
    // From *after* the close: the block's own `Mov <scratch>, state` (v99, §7)
    // is a read of `state` that goes away with the close itself.
    if (registerLiveAfter(fn, c, at + 1, state)) return null;
    // …and every scratch register those `Mov`s write goes away too, so each
    // must be dead after the block the rung is deleting.
    for (const x of insns.slice(0, at)) {
      const d = regOperand(x, 0);
      if (d !== undefined && registerLiveAfter(fn, c, at + 1, d)) return null;
    }
  }

  const close = [...normalCloses, handlerBlock];
  const form: IterForm = { kind: "for-of", cond: bH, at: "head", negate, iter: bH, setup: setupStmt.cfgBlock, close, binding: v, source: srcInHeader, ...(mergeLabel === undefined ? {} : { mergeLabel }) };
  const start = fn.graph.blocks[bH]?.block?.start ?? 0;
  return { root: node, nodes: [node, guard, tryNode], data: { loop: node, form }, at: { functionIndex: ctx.functionIndex, offset: start } };
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

interface Located {
  readonly tryNode: Stmt;
  readonly negate: boolean;
  /** Label of the merge-point wrapper the `try` sits inside, when its handler
   *  is `break <that label>` rather than the cleanup block itself. */
  readonly mergeLabel?: number;
  /** The statement immediately following that wrapper: the shared
   *  `Catch; IteratorClose state, 1; Throw` the wrapper's breaks land on. */
  readonly mergeHandler?: Stmt;
}

/**
 * Finds the `try` continuing the loop: nested in one arm of `guard`, a flat
 * sibling after it, or one level inside a `labeled` merge-point wrapper.
 *
 * The wrapper case is what v84/v94/v96 emit for a loop with a source `break`
 * (`06-for-of-array`'s first loop): the break path needs its own
 * `IteratorClose`-then-break, so it gets its own nested `try`, and the two
 * regions then *share* one handler — which `src/structure/ir.ts`'s
 * `AugmentedCfg` note calls a merge point. Neither `try` owns the cleanup
 * block as its `handler` field; both carry `break <mergeLabel>` and the real
 * `Catch; IteratorClose; Throw` is the wrapper's following sibling.
 */
function locateTry(guard: IfNode, flatRest: readonly Stmt[], loopLabel: number): Located | null {
  const thenItems = items(guard.then);
  const elseItems = items(guard.else);
  const thenTry = findContinuingTry(thenItems, loopLabel);
  const elseTry = findContinuingTry(elseItems, loopLabel);
  if (thenTry !== null && elseTry === null) return { ...thenTry, negate: false };
  if (elseTry !== null && thenTry === null) return { ...elseTry, negate: true };
  if (thenTry !== null && elseTry !== null) return null; // ambiguous
  const flatTry = findContinuingTry(flatRest, loopLabel);
  if (flatTry === null) return null;
  // Neither arm holds it: whichever arm is non-empty is the exit.
  if (thenItems.length > 0 && elseItems.length === 0) return { ...flatTry, negate: false };
  if (elseItems.length > 0 && thenItems.length === 0) return { ...flatTry, negate: true };
  return null;
}

/** The `try` holding the back edge in `list`, directly or through one
 *  `labeled` merge-point wrapper. `null` when there is none, or more than
 *  one candidate (ambiguous — refuse rather than guess). */
function findContinuingTry(list: readonly Stmt[], loopLabel: number): Omit<Located, "negate"> | null {
  const found: Omit<Located, "negate">[] = [];
  for (const [i, s] of list.entries()) {
    if (s.k === "try" && endsWithContinue(s, loopLabel)) found.push({ tryNode: s });
    if (s.k !== "labeled") continue;
    const inner = items(s.body);
    const nested = inner.filter((c) => c.k === "try" && endsWithContinue(c, loopLabel));
    if (nested.length !== 1) continue;
    const after = list[i + 1];
    if (after === undefined) continue;
    found.push({ tryNode: nested[0]!, mergeLabel: s.label, mergeHandler: after });
  }
  return found.length === 1 ? found[0]! : null;
}

/** The CFG block holding a `try`'s cleanup: its own `handler`, or — in the
 *  merge-point shape — the wrapper's following sibling that `break
 *  <mergeLabel>` lands on. */
function resolveHandlerBlock(tryNode: TryNode, mergeLabel: number | undefined, mergeHandler: Stmt | undefined): number | null {
  const h = tryNode.handler;
  if (mergeLabel !== undefined && h.k === "break" && h.label === mergeLabel) {
    return mergeHandler === undefined ? null : handlerCfgBlock(mergeHandler);
  }
  return handlerCfgBlock(h);
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
function findNormalCloses(fn: StructuredFunction, body: Stmt, state: number, isCleanupTry: (t: TryNode) => boolean): readonly number[] | null {
  const out: number[] = [];
  const top = items(body);
  for (const [i, s] of top.entries()) {
    if (!visitDeep(s, top, i, fn, state, out, isCleanupTry)) return null;
  }
  return out;
}

/** Is `insn` pure iterator plumbing a dropped close block may carry? (§4.2 P6:
 *  "only `Mov`s between the close and the block's other instructions", plus
 *  the block's own unconditional jump, which the tree already expresses.) */
function isCloseFiller(insn: Instruction): boolean {
  return insn.name === "Mov" || insn.name === "MovLong" || insn.name === "Jmp" || insn.name === "JmpLong";
}

/** Depth-first, but tracks each statement's own sibling list so "immediately followed by a break" is checked in the right list. */
function visitDeep(s: Stmt, siblings: readonly Stmt[], index: number, fn: StructuredFunction, state: number, out: number[], isCleanupTry: (t: TryNode) => boolean): boolean {
  if (s.k === "block") {
    const insns = instructionsOf(fn, s.cfgBlock);
    if (insns === null || insns.length === 0) return true;
    const ci = insns.findIndex((x) => x.name === "IteratorClose");
    if (ci < 0) return true;
    // v99 copies the state into a scratch register first (`Mov r0, r4 ;
    // IteratorClose r0, 0`, §7), so the close's operand is resolved through
    // this block's own leading `Mov`s before it is compared with `state`.
    const reg = closeStateOf(insns, ci);
    if (reg !== state) return true; // not this loop's iterator state — not this rung's concern
    if (insns[ci]!.operands[1]?.value !== 0) return false; // an unexpected abrupt close outside the handler
    // The whole block is dropped at print time, so nothing in it may carry a
    // JS value: only `Mov` plumbing and the block's own jump may keep it company.
    if (insns.some((x, i) => i !== ci && !isCloseFiller(x))) return false;
    const next = siblings[index + 1];
    if (next === undefined || next.k !== "break") return false;
    out.push(s.cfgBlock);
    return true;
  }
  if (s.k === "if") {
    const thenItems = items(s.then);
    const elseItems = items(s.else);
    return thenItems.every((c, i) => visitDeep(c, thenItems, i, fn, state, out, isCleanupTry)) && elseItems.every((c, i) => visitDeep(c, elseItems, i, fn, state, out, isCleanupTry));
  }
  if (s.k === "labeled" || s.k === "loop") {
    const inner = items(s.body);
    return inner.every((c, i) => visitDeep(c, inner, i, fn, state, out, isCleanupTry));
  }
  if (s.k === "try") {
    // A nested `try` inside the loop body is only ever the break path's own
    // exception safety (v84/v94/v96's merge-point shape): it must share this
    // loop's cleanup handler, or it is a user `try` and `try-shape` owns it.
    if (!isCleanupTry(s)) return false;
    const inner = items(s.body);
    return inner.every((c, i) => visitDeep(c, inner, i, fn, state, out, isCleanupTry));
  }
  return true;
}

/** The iteration-state register a block's `IteratorClose` at `ci` really names,
 *  resolved through that block's own leading `Mov`s (v99 copies `state` into a
 *  scratch register first, §7). Shared with `check.ts` so both stages ask the
 *  same question of the same register. */
export function closeStateOf(insns: readonly Instruction[], ci: number): number | undefined {
  const alias = new Map<number, number>();
  for (const x of insns.slice(0, ci)) {
    if (x.name !== "Mov" && x.name !== "MovLong") continue;
    const d = regOperand(x, 0);
    const src = regOperand(x, 1);
    if (d !== undefined && src !== undefined) alias.set(d, alias.get(src) ?? src);
  }
  const raw = regOperand(insns[ci]!, 0);
  return raw === undefined ? undefined : (alias.get(raw) ?? raw);
}

export type { Instruction };
