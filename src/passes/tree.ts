// Pure tree helpers shared by the stage-A passes. Nothing here mutates.
//
// This is *framework*, not a pass: D12a's import boundary (a pass may reach
// only `src/passes/**` and `src/structure`'s public IR) is enforced on
// `src/passes/<name>/**`, and this file exists so a pass never has to reach
// past it. In particular the first-test proof below borrows the emitter's own
// `conditionFor`, so a pass can never disagree with the printer about a
// condition's polarity.
import { conditionFor } from "../emit/conds.ts";
import type { Expr } from "../emit/ast.ts";
import type { Instruction } from "../disasm/decode.ts";
import type { BlockId } from "../cfg/types.ts";
import type { ModuleAnalysis } from "../cfg/types.ts";
import { writtenRegisters } from "../cfg/reg-effects.ts";
import { children } from "../structure/ir.ts";
import type { LabelId, Stmt, StructuredFunction } from "../structure/ir.ts";
import { postOrder } from "./driver.ts";

export type { BlockId } from "../cfg/types.ts";
export type { Instruction } from "../disasm/decode.ts";
export { writtenRegisters } from "../cfg/reg-effects.ts";

/**
 * F6 (spec `docs/specs/passes/01-framework-fixes.md`): a read-only,
 * whole-module view built once per module by `src/passes/index.ts` and handed
 * to every pass as `ctx.module`. Framework, so it may reach into `src/cfg`
 * (`ModuleAnalysis`) even though a pass itself never may — by convention only
 * the naming rungs and `jsx-recover` read it; nothing in batch 1 does.
 */
export interface ModuleView {
  readonly functionCount: number;
  /** `""` when the function is anonymous. */
  functionName(index: number): string;
  isGlobalFunction(index: number): boolean;
  envSlotAccesses(env: number, slot: number): readonly { readonly functionIndex: number; readonly offset: number }[];
  /**
   * `src/deps`' confirmed-package verdict for this module, when the caller
   * computed one (it is a separate, opt-in analysis — `hbc2js deps`, not the
   * decompile pipeline this ladder runs under); `null` otherwise, which is
   * what every `ctx.module` is in batch 1.
   */
  depsVerdict(): readonly { readonly module: number; readonly package: string; readonly confidence: number }[] | null;
}

/** Builds `ctx.module` from the same `ModuleAnalysis` the pass pipeline already has in hand. */
export function buildModuleView(analysis: ModuleAnalysis): ModuleView {
  const mod = analysis.module;
  return {
    functionCount: mod.functions.length,
    functionName(index: number): string {
      return mod.functions[index]?.name ?? "";
    },
    isGlobalFunction(index: number): boolean {
      return index === mod.header.globalCodeIndex;
    },
    envSlotAccesses(env: number, slot: number): readonly { readonly functionIndex: number; readonly offset: number }[] {
      const s = analysis.envGraph.slots.find((x) => x.env === env && x.slot === slot);
      return s === undefined ? [] : s.accesses.map((a) => ({ functionIndex: a.functionIndex, offset: a.offset }));
    },
    depsVerdict(): null {
      return null;
    },
  };
}

/** F4: `s.k === "seq" ? s.body : [s]` — the one-or-many view of a statement
 *  list every loop-shaped matcher/rewriter needs. Both shipped rungs
 *  private-defined this; this is the third copy, so it moved here. */
export function items(s: Stmt): readonly Stmt[] {
  return s.k === "seq" ? s.body : [s];
}

/** `s` is exactly `break label` / `continue label`. Replaces the private
 *  `isJump(s, "break"|"continue", label)` both shipped rungs had. */
export function isBreakTo(s: Stmt, label: LabelId): boolean {
  return s.k === "break" && s.label === label;
}
export function isContinueTo(s: Stmt, label: LabelId): boolean {
  return s.k === "continue" && s.label === label;
}

export interface LabelUse {
  readonly breaks: number;
  readonly continues: number;
}

/** How many `break L` / `continue L` occur anywhere under `node`. */
export function usesOf(node: Stmt, label: LabelId): LabelUse {
  let breaks = 0;
  let continues = 0;
  for (const n of postOrder(node)) {
    if (n.k === "break" && n.label === label) breaks++;
    else if (n.k === "continue" && n.label === label) continues++;
  }
  return { breaks, continues };
}

/** Every CFG block referenced under `node`, in tree order, with repeats. */
export function blocksOf(node: Stmt): BlockId[] {
  const out: BlockId[] = [];
  for (const n of postOrder(node)) {
    if (n.k === "block" || n.k === "if" || n.k === "return" || n.k === "throw" || n.k === "switch" || n.k === "try") out.push(n.cfgBlock);
  }
  return out;
}

/**
 * `blocksOf` as a multiset (ladder §4.1): the CF-preserving `check` class
 * (`label-clean` and, later, `finally-dedup`/`switch-raise`/`if-chain`/
 * `try-shape`) asserts `blocksMultiset(before)` equals `blocksMultiset(after)`
 * — no `block`/`if`/`return`/`throw`/`switch`/`try` leaf is added, removed or
 * duplicated by a rewrite that only deletes label wrappers and jumps.
 */
export function blocksMultiset(node: Stmt): Map<BlockId, number> {
  const out = new Map<BlockId, number>();
  for (const b of blocksOf(node)) out.set(b, (out.get(b) ?? 0) + 1);
  return out;
}

/**
 * Conservative "can control fall off the end of this statement". `true` is the
 * safe answer; a pass that needs `false` gets it only for shapes that plainly
 * cannot complete normally (a jump, or a seq/if/labeled/loop built from them).
 */
export function completesNormally(node: Stmt): boolean {
  switch (node.k) {
    case "break":
    case "continue":
    case "return":
    case "throw":
    case "unreachable":
      return false;
    case "seq":
      return node.body.every(completesNormally);
    case "if":
      return completesNormally(node.then) || completesNormally(node.else);
    case "labeled":
      return completesNormally(node.body) || usesOf(node.body, node.label).breaks > 0;
    case "loop":
      return usesOf(node.body, node.label).breaks > 0;
    default:
      return true;
  }
}

/** The straight-line body of a CFG block (never a synthetic try-head). */
export function instructionsOf(fn: StructuredFunction, block: BlockId): readonly Instruction[] | null {
  const aug = fn.graph.blocks[block];
  if (aug === undefined || aug.block === null) return null;
  return aug.block.instructions;
}

export function sameShape(a: Stmt, b: Stmt): boolean {
  const ca = children(a);
  const cb = children(b);
  if (a.k !== b.k || ca.length !== cb.length) return false;
  return ca.every((c, i) => sameShape(c, cb[i]!));
}

/**
 * Registers a fused compare reads, i.e. the loop test's inputs. Only the
 * register-to-register jump family (`JLess r, r` …) and the one-register
 * `JmpTrue`/`JmpFalse` are accepted; anything else (builtin/typeof tests) is
 * not a loop condition a pass should reason about.
 */
export function condInputs(last: Instruction): number[] | null {
  if (!/^J(mpTrue|mpFalse|Less|Greater|NotLess|NotGreater|Equal|NotEqual|StrictEqual|StrictNotEqual)/.test(last.name)) return null;
  return last.operands.filter((o) => o.role === "reg").map((o) => o.value);
}

const NUMERIC_CONST: Readonly<Record<string, (insn: Instruction) => number | boolean | undefined>> = {
  LoadConstZero: () => 0,
  LoadConstUInt8: (i) => i.operands[1]!.value,
  LoadConstInt: (i) => i.operands[1]!.value,
  LoadConstDouble: (i) => i.operands[1]!.value,
  LoadConstTrue: () => true,
  LoadConstFalse: () => false,
};

/**
 * The value a register holds when control enters a loop, if it is knowable
 * from (a) the block that falls into the loop — its last write wins — or
 * (b) a register written exactly once in the whole function, by a numeric
 * constant load in the entry block (then every read after the prologue sees
 * that value). `Mov` chains resolve through the same rules. `undefined` when
 * unknown; the caller then refuses.
 */
export function valueAtLoopEntry(fn: StructuredFunction, pred: BlockId, register: number, depth = 0): number | boolean | undefined {
  if (depth > 8) return undefined;
  const insns = instructionsOf(fn, pred);
  if (insns === null) return undefined;
  for (let i = insns.length - 1; i >= 0; i--) {
    const insn = insns[i]!;
    if (!writtenRegisters(insn).includes(register)) continue;
    const c = NUMERIC_CONST[insn.name];
    if (c !== undefined) return c(insn);
    if (insn.name === "Mov" && insn.operands[1]?.role === "reg") {
      // The source's value is whatever it held just before this Mov: rescan
      // this block up to `i`, then fall back to the single-def rule.
      const src = insn.operands[1].value;
      for (let j = i - 1; j >= 0; j--) {
        const w = insns[j]!;
        if (!writtenRegisters(w).includes(src)) continue;
        const cc = NUMERIC_CONST[w.name];
        return cc === undefined ? undefined : cc(w);
      }
      return singleDefConstant(fn, src);
    }
    return undefined;
  }
  return singleDefConstant(fn, register);
}

function singleDefConstant(fn: StructuredFunction, register: number): number | boolean | undefined {
  const cfg = fn.graph.cfg;
  let def: Instruction | null = null;
  let defBlock = -1;
  for (const b of cfg.blocks) {
    for (const insn of b.instructions) {
      if (!writtenRegisters(insn).includes(register)) continue;
      if (def !== null) return undefined;
      def = insn;
      defBlock = b.id;
    }
  }
  if (def === null || defBlock !== cfg.entry) return undefined;
  // Parameters and `this` live in registers too; a register the entry block
  // writes once could still have been read earlier in that block as an
  // incoming value. Only constants count, and only if nothing reads the
  // register before the write.
  const entry = cfg.blocks[cfg.entry]!;
  for (const insn of entry.instructions) {
    if (insn === def) break;
    if (insn.operands.some((o) => o.role === "reg" && o.value === register)) return undefined;
  }
  const c = NUMERIC_CONST[def.name];
  return c === undefined ? undefined : c(def);
}

/**
 * Does the loop test hold on the *first* arrival, given `pred` is the block
 * that falls into the loop? A rotated `while`/`for` loses its pre-test to
 * constant folding exactly when it does; `do { B } while (c)` is then also
 * `while (c) { B }`, which is what lets for-header promote it. Provable only
 * when every register the test reads has a known value at loop entry
 * (`valueAtLoopEntry`); anything else answers `false` and the loop stays a
 * `do … while`.
 *
 * `negate` has the `LoopForm` meaning: the printed test is `!c` when set, so
 * the answer is the truth of the *printed* test, not of the taken edge.
 */
export function firstTestHolds(fn: StructuredFunction, pred: BlockId, cond: BlockId, negate: boolean, functionIndex: number): boolean {
  const insns = instructionsOf(fn, cond);
  if (insns === null || insns.length === 0) return false;
  const last = insns[insns.length - 1]!;
  const inputs = condInputs(last);
  if (inputs === null) return false;
  const env = new Map<string, number | boolean>();
  for (const r of inputs) {
    const v = valueAtLoopEntry(fn, pred, r);
    if (v === undefined) return false;
    env.set(String(r), v);
  }
  const regs = inputs.map((r): Expr => ({ k: "ident", name: String(r) }));
  let taken: boolean | number | undefined;
  try {
    taken = evaluate(conditionFor(last, regs, {}, functionIndex), env);
  } catch {
    return false; // an unresolvable condition (e.g. JmpBuiltinIs) is not a proof
  }
  if (taken === undefined) return false;
  return negate ? !taken : Boolean(taken);
}

/** Constant-folds the small expression shapes `conditionFor` builds for a compare. */
function evaluate(e: Expr, env: ReadonlyMap<string, number | boolean>): boolean | number | undefined {
  switch (e.k) {
    case "ident":
      return env.get(e.name);
    case "lit": {
      if (e.text === "true") return true;
      if (e.text === "false") return false;
      const n = Number(e.text);
      return Number.isNaN(n) ? undefined : n;
    }
    case "unary": {
      const v = evaluate(e.arg, env);
      return e.op === "!" && v !== undefined ? !v : undefined;
    }
    case "bin": {
      const l = evaluate(e.left, env);
      const r = evaluate(e.right, env);
      if (l === undefined || r === undefined) return undefined;
      switch (e.op) {
        case "<": return l < r;
        case "<=": return l <= r;
        case ">": return l > r;
        case ">=": return l >= r;
        case "==": return l == r; // eslint-disable-line eqeqeq
        case "!=": return l != r; // eslint-disable-line eqeqeq
        case "===": return l === r;
        case "!==": return l !== r;
        default: return undefined;
      }
    }
    default:
      return undefined;
  }
}
