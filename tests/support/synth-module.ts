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

export function instructions(ops: readonly Op[]): Instruction[] {
  return ops.map((o, i) => ({
    offset: i * 4,
    length: 4,
    opcode: 0,
    name: o.name,
    operands: o.ops.map(([role, value]) => ({ type: "Reg8", role, value }) as unknown as Operand),
    kind: o.name === "Ret" ? ("return" as const) : ("normal" as const),
    targets: [] as readonly number[],
    fallsThrough: o.name !== "Ret",
  }));
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
