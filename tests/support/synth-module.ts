// Synthetic `buildEnvGraph` / `emitModule` inputs, shared by
// tests/gate/cfg/closure-copies.test.ts and tests/gate/emit/closure-copies.test.ts.
// Same shape as the fake module in tests/gate/cfg/env-no-capture.test.ts: no
// bytes are parsed, the instruction stream is written by hand, because the
// shapes under test (docs/reports/2026-09-05-ambiguous-closure-env.md) are ones
// hermesc does not emit for any small `source.js`.
import { buildCfg, buildEnvGraph } from "../../src/cfg/index.ts";
import type { EnvGraph, FunctionCfg } from "../../src/cfg/types.ts";
import type { DecodedFunction, Instruction, Operand } from "../../src/disasm/decode.ts";
import type { HbcModule } from "../../src/parse/types.ts";

export type Op = { readonly name: string; readonly ops: readonly (readonly [string, number])[] };

/** Ops whose `kind` is not `normal`. A synthetic body needs real terminators
 *  as soon as it contains a LOOP (report §5 "Landing item 3": a copy captured
 *  over a loop-local environment), because `buildCfg` splits blocks on
 *  `targets` and `inCycle` needs the back edge. `addr` operands are absolute
 *  offsets, as they are after `src/disasm` resolves them. */
const UNCONDITIONAL_JUMPS = new Set(["Jmp", "JmpLong"]);
const CONDITIONAL_JUMPS = new Set(["JmpTrue", "JmpTrueLong", "JmpFalse", "JmpFalseLong"]);

export function instructions(ops: readonly Op[]): Instruction[] {
  return ops.map((o, i) => {
    const kind = o.name === "Ret" ? ("return" as const) : UNCONDITIONAL_JUMPS.has(o.name) ? ("jump" as const) : CONDITIONAL_JUMPS.has(o.name) ? ("condJump" as const) : ("normal" as const);
    return {
      offset: i * 4,
      length: 4,
      opcode: 0,
      name: o.name,
      operands: o.ops.map(([role, value]) => ({ type: role === "addr" ? "Addr8" : "Reg8", role, value }) as unknown as Operand),
      kind,
      targets: o.ops.filter(([role]) => role === "addr").map(([, value]) => value) as readonly number[],
      fallsThrough: kind !== "return" && kind !== "jump",
    };
  });
}

export function fakeFunction(index: number, ops: readonly Op[]): DecodedFunction {
  const insns = instructions(ops);
  return {
    index,
    header: { environmentSize: 1, paramCount: 1, frameSize: 8, bytecodeSizeInBytes: insns.length * 4, flags: { strictMode: false } },
    name: `fn${index}`,
    instructions: insns,
    byOffset: new Map(insns.map((x, i) => [x.offset, i])),
    labels: new Map(),
    handlers: [],
    switchTables: [],
    diagnostics: [],
  } as unknown as DecodedFunction;
}

export function fakeCfg(index: number, fn: DecodedFunction): FunctionCfg {
  const end = fn.instructions.length * 4;
  return {
    functionIndex: index,
    blocks: [{ id: 0, start: 0, end, instructions: fn.instructions, succs: [], preds: [], isHandlerEntry: false }],
    entry: 0,
    exits: [0],
    byOffset: new Map([[0, 0]]),
    exceptionSuccs: new Map(),
    regions: [],
    switchTables: [],
    rpo: [0],
    reducible: true,
    generator: { kind: "none", suspendPoints: [] },
    frameSize: 8,
    paramCount: 1,
    diagnostics: [],
  } as unknown as FunctionCfg;
}

export function graphOf(bodies: ReadonlyMap<number, readonly Op[]>): EnvGraph {
  const fns = new Map([...bodies].map(([i, ops]) => [i, fakeFunction(i, ops)]));
  const cfgs = new Map([...fns].map(([i, f]) => [i, fakeCfg(i, f)]));
  return buildEnvGraph({
    module: { header: { globalCodeIndex: 0 } } as unknown as HbcModule,
    decode: (i) => fns.get(i)!,
    cfg: (i) => cfgs.get(i)!,
    functionIndices: [...fns.keys()],
  });
}

/** `CreateEnvironment rD` in the v<=96 one-operand form: parent = the creating
 *  function's own captured environment, size from the function header. */
export const mkEnv = (r: number): Op => ({ name: "CreateEnvironment", ops: [["reg", r]] });
export const mkClosure = (dst: number, env: number, fn: number): Op => ({ name: "CreateClosure", ops: [["reg", dst], ["reg", env], ["function", fn]] });
/** `GetEnvironment rD, 0` — the closure's own environment (v<=96 two-operand form). */
export const selfEnv = (r: number): Op => ({ name: "GetEnvironment", ops: [["reg", r], ["imm", 0]] });
export const loadSlot = (dst: number, env: number, slot: number): Op => ({ name: "LoadFromEnvironment", ops: [["reg", dst], ["reg", env], ["imm", slot]] });
export const ret = (r: number): Op => ({ name: "Ret", ops: [["reg", r]] });

/**
 * Bucket A (report §2: 129 of 178) — two *different* creating functions, chains
 * of the same length identical above the leaf, and the body reads the leaf.
 * fn#0 (global) makes env 0; fn#1 and fn#2 each capture it and make env 1 / env
 * 2; both create fn#3, which reads slot 0 of whatever it captured.
 */
export function bucketAFunctions(readsLeaf = true): Map<number, readonly Op[]> {
  return new Map<number, readonly Op[]>([
    [0, [mkEnv(0), mkClosure(1, 0, 1), mkClosure(2, 0, 2), ret(1)]],
    [1, [mkEnv(0), mkClosure(1, 0, 3), ret(1)]],
    [2, [mkEnv(0), mkClosure(1, 0, 3), ret(1)]],
    [3, readsLeaf ? [selfEnv(0), loadSlot(1, 0, 0), ret(1)] : [ret(0)]],
  ]);
}

export function bucketA(readsLeaf = true): EnvGraph {
  return graphOf(bucketAFunctions(readsLeaf));
}

/** Bucket B (23 of 178) — both sites inside ONE creating function (Hermes
 *  inlined a closure-making helper twice), still aligned. */
export function bucketB(): EnvGraph {
  return graphOf(
    new Map<number, readonly Op[]>([
      [0, [mkEnv(0), mkClosure(1, 0, 1), ret(1)]],
      [1, [mkEnv(0), mkEnv(1), mkClosure(2, 0, 2), mkClosure(3, 1, 2), ret(2)]],
      [2, [selfEnv(0), loadSlot(1, 0, 0), ret(1)]],
    ]),
  );
}

/** Bucket C (15 of 178) — chains of *different length*. There is no positional
 *  remap, so this one keeps today's behaviour. */
export function bucketC(): EnvGraph {
  return graphOf(
    new Map<number, readonly Op[]>([
      [0, [mkEnv(0), mkClosure(1, 0, 1), mkClosure(2, 0, 2), ret(1)]],
      [1, [mkEnv(0), mkClosure(1, 0, 2), ret(1)]],
      [2, [selfEnv(0), loadSlot(1, 0, 0), ret(1)]],
    ]),
  );
}


/**
 * The *real* `buildCfg` over a hand-written instruction stream. `fakeCfg` above
 * is enough for `buildEnvGraph` (which only walks blocks and instructions), but
 * the structurer needs the block terminators and dominator data only the real
 * builder produces.
 */
export function realCfg(fn: DecodedFunction): FunctionCfg {
  return buildCfg(fn, {
    kind: { index: fn.index, kind: "normal" } as unknown as import("../../src/cfg/types.ts").FunctionKindInfo,
    maxBlocks: 100000,
    checkInvariants: false,
    disableResumeDispatch: false,
  });
}

/**
 * Bucket A plus the two shapes report §5 item 1 is about, on top of the same
 * duplicated function fn#3:
 *
 *  * **fn#4 travels.** fn#3 creates it over the environment fn#3 itself
 *    *captured*, so `closureEnvOf(4)` is env 1 — owned by fn#1, i.e. beside
 *    copy 0 — and copy 1 (inside fn#2) cannot see `_fn4` at all. fn#1 also
 *    creates it directly, from a site that is NOT duplicated, so the copy-0
 *    instance must stay exactly where it is: that second site is what broke
 *    the reverted "reparent the function index inward" attempt (report §5).
 *  * **fn#5 does not travel.** fn#3 creates it over an environment fn#3 *owns*
 *    (env 3), so it is an ordinary child that is emitted once per copy — and
 *    must keep its own `_fn5` name in every copy.
 */
export function travelFunctions(): Map<number, readonly Op[]> {
  return new Map<number, readonly Op[]>([
    [0, [mkEnv(0), mkClosure(1, 0, 1), mkClosure(2, 0, 2), ret(1)]],
    [1, [mkEnv(0), mkClosure(1, 0, 3), mkClosure(2, 0, 4), ret(1)]],
    [2, [mkEnv(0), mkClosure(1, 0, 3), ret(1)]],
    // env 3 is fn#3's own; reg 2 is the environment fn#3 captured (env 1 / env 2).
    [3, [mkEnv(0), mkClosure(1, 0, 5), selfEnv(2), mkClosure(3, 2, 4), loadSlot(4, 2, 0), ret(4)]],
    [4, [selfEnv(0), loadSlot(1, 0, 0), ret(1)]],
    [5, [selfEnv(0), loadSlot(1, 0, 0), ret(1)]],
  ]);
}

export function travel(): EnvGraph {
  return graphOf(travelFunctions());
}

/** `GetEnvironment rD, levels` — `levels` steps up from the closure's own
 *  environment (v<=96 two-operand form). `selfEnv` is `levels = 0`. */
export const outerEnv = (r: number, levels: number): Op => ({ name: "GetEnvironment", ops: [["reg", r], ["imm", levels]] });
/** `CreateEnvironment rD, rParent, size` — the v>=97 form with an EXPLICIT
 *  parent register, so the new environment need not hang off the creating
 *  closure's own one. */
export const mkEnvUnder = (dst: number, parent: number, size: number): Op => ({ name: "CreateEnvironment", ops: [["reg", dst], ["reg", parent], ["imm", size]] });

/**
 * A **recursion group** (report §5 "Landing item 2"): fn#3 and fn#4 create each
 * other *and* themselves, so their copies are mutually referring. This is the
 * shape of react-navigation's `_fn12406`/`_fn12407`, down to the environment:
 * each of them creates an environment whose parent is its own *grandparent*
 * (`GetEnvironment r, 1`), not the environment it captured, which is what keeps
 * every copy's chain the same length — without that the group's inner copies
 * would be unaligned and never duplicated at all.
 *
 * So fn#3 and fn#4 each have four creation contexts: env 1 (fn#1), env 2
 * (fn#2), env 3 (owned by fn#3) and env 4 (owned by fn#4). The last two are
 * hosted *inside a member of the group itself*, so they must be emitted inside
 * every instance of that member — a copy hosted only beside copy 0 is invisible
 * to every other copy, which is exactly the 35 unbound `_fn<n>__c<i>` names the
 * report's item 1 left behind.
 */
export function mutualRecursionFunctions(): Map<number, readonly Op[]> {
  const groupMember = (): readonly Op[] => [outerEnv(5, 1), mkEnvUnder(0, 5, 2), mkClosure(1, 0, 3), mkClosure(2, 0, 4), selfEnv(6), loadSlot(7, 6, 0), ret(7)];
  return new Map<number, readonly Op[]>([
    [0, [mkEnv(0), mkClosure(1, 0, 1), mkClosure(2, 0, 2), ret(1)]],
    [1, [mkEnv(0), mkClosure(1, 0, 3), mkClosure(2, 0, 4), ret(1)]],
    [2, [mkEnv(0), mkClosure(1, 0, 3), mkClosure(2, 0, 4), ret(1)]],
    [3, groupMember()],
    [4, groupMember()],
  ]);
}

/** `JmpTrue <absolute offset>, rCond` — a back edge, so the block it ends is in
 *  a cycle. */
export const jmpTrue = (target: number, cond: number): Op => ({ name: "JmpTrue", ops: [["addr", target], ["reg", cond]] });

/**
 * Report §5 "Landing item 3", the 2 `_e2192_0`: a duplicated function whose
 * copy 1 captures a **loop-local** environment.
 *
 * fn#1 and fn#2 both create fn#3, aligned (bucket A), so fn#3 gets two copies.
 * fn#2's environment is created *inside a loop* and is read by nothing but the
 * closure it makes — which is exactly what makes it loop-local: its `let` is
 * emitted at the `CreateEnvironment`, inside the loop body's block, so a copy
 * hoisted to the top of fn#2 cannot see it (`_e2_0` unbound). Copy 0's home,
 * fn#1, has no loop, so copy 0 is unaffected.
 *
 * This is react-navigation's `_fn10396__c1`/`_fn10397__c1` in miniature: env
 * 2192 (owner fn#3497) has one writer and no readers, is created in a loop, and
 * copy 1's remap `2190 -> 2192` makes the copy's body read `_e2192_0`.
 */
export function loopLocalCopyFunctions(): Map<number, readonly Op[]> {
  return new Map<number, readonly Op[]>([
    [0, [mkEnv(0), mkClosure(1, 0, 1), mkClosure(2, 0, 2), ret(1)]],
    [1, [mkEnv(0), mkClosure(1, 0, 3), ret(1)]],
    // offsets 0/4/8: the CreateEnvironment, the CreateClosure and the back edge
    // to offset 0 all sit in ONE block, and that block is its own successor.
    [2, [mkEnv(0), mkClosure(1, 0, 3), jmpTrue(0, 1), ret(1)]],
    [3, [selfEnv(0), loadSlot(1, 0, 0), ret(1)]],
  ]);
}

/**
 * Report §5 leftover 7, "the child that stays behind". Bucket A with a body
 * that reads neither leaf, so fn#3 is JOINED and `src/emit/index.ts` re-hosts
 * it at the lowest common ancestor of fn#1 and fn#2 — plus the two kinds of
 * child a joined function can create over the environment it merely CAPTURED
 * (`selfEnv(0)`, i.e. env 1 / env 2, whose owner is fn#1, so `closureEnvOf`
 * parks both children beside fn#3's OLD home):
 *
 *  * **fn#4 travels.** It reads no environment slot at all, so it is legal
 *    anywhere fn#3 is legal and moves into fn#3 (`W_JOINED_CHILD_MOVED`).
 *  * **fn#4 "pinned" must not travel.** It reads slot 0 of the captured environment,
 *    which is exactly the environment the two sites DISAGREE about, so no
 *    single home can bind it: it needs one instance per site (per-instance
 *    `parentOf`), not a move. This is react-navigation's `_fn14790` /
 *    `_fn15473` / `_fn15478`, and moving it anyway was measured worse
 *    (22 -> 23 unbound names).
 *
 * `pull` picks which child fn#4 is, because a fixture holding both would have
 * fn#3 isolated for the pinned one and its stub would swallow the moved one's
 * declaration. (Both are index 4: `emitSynth` indexes its function array by
 * position, so the indices have to be contiguous.)
 */
export function joinedChildFunctions(pull: "movable" | "pinned" | "grandchild"): Map<number, readonly Op[]> {
  const bodies = new Map<number, readonly Op[]>([
    [0, [mkEnv(0), mkClosure(1, 0, 1), mkClosure(2, 0, 2), ret(1)]],
    [1, [mkEnv(0), mkClosure(1, 0, 3), ret(1)]],
    [2, [mkEnv(0), mkClosure(1, 0, 3), ret(1)]],
    [3, [selfEnv(0), mkClosure(1, 0, 4), ret(1)]],
    [4, pull === "movable" ? [ret(0)] : [selfEnv(0), loadSlot(1, 0, 0), ret(1)]],
  ]);
  // "grandchild": the read that decides the join sits one level further down —
  // fn#4 creates fn#5 over the environment IT captured (fn#3's captured
  // environment, i.e. the one fn#1 and fn#2 disagree about) and fn#5 is what
  // reads it. Neither fn#4 nor fn#5 is a `closureEnvOf` child of fn#3, so
  // reaching fn#5 needs the creation-based subtree to run to a FIXED POINT:
  // fn#4 joins because its only creator is fn#3, and only then does fn#5.
  if (pull === "grandchild") {
    bodies.set(4, [selfEnv(0), mkClosure(1, 0, 5), ret(1)]);
    bodies.set(5, [selfEnv(0), loadSlot(1, 0, 0), ret(1)]);
  }
  return bodies;
}
