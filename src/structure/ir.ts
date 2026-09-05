// docs/specs/04-structurer.md §2 — the structured tree IR.
//
// Leaves reference CFG blocks; they never copy instructions. The IR is a
// *shape*, which is what makes the §5 round-trip check cheap.
import type { Diagnostic } from "../errors.ts";
import type { SwitchTable } from "../disasm/switchtable.ts";
import type { BasicBlock, BlockId, Edge, FunctionCfg } from "../cfg/types.ts";

export type LabelId = number;

export type Stmt =
  /** A straight-line run of one CFG block's instructions. The leaf of the tree. */
  | { readonly k: "block"; readonly cfgBlock: BlockId }
  | { readonly k: "seq"; readonly body: readonly Stmt[] }
  /** `label: { body }` — target of a forward multi-level break. */
  | { readonly k: "labeled"; readonly label: LabelId; readonly body: Stmt }
  /**
   * `label: while (true) { body }`. `form` is a spec 07 stage-A annotation
   * (src/passes/loop-cond): it names which `if` inside `body` is the loop test
   * so the emitter can print `while (c)` / `do … while (c)` / `for (…)`. It is
   * transparent to verify.ts — the guarded `if`/`continue`/`break` stay in the
   * tree, so the §5 round-trip proves the annotated tree exactly as before.
   */
  /**
   * `hideLabel` (spec `docs/specs/passes/01-framework-fixes.md` F9): set by
   * `06-label-clean` once every `break`/`continue` under `body` that used to
   * target this loop's `label` has itself been rewritten unlabelled — the
   * emitter then prints `label: null` for the loop and for those jumps.
   * Transparent to verify.ts, exactly like `form`. Nothing sets it in batch 1.
   */
  | { readonly k: "loop"; readonly label: LabelId; readonly body: Stmt; readonly form?: LoopForm; readonly hideLabel?: boolean }
  /**
   * Two-way branch on the terminator of `cfgBlock`. `elseIf`
   * (docs/specs/passes/09-if-chain.md §3/§5, set by src/passes/if-chain C3)
   * marks an `else` arm that is a chain link — `[if]` or `[block bX, if bX]`
   * — so the printer may render `else if` once stage B has folded the
   * condition-computing block into the condition. Transparent to verify.ts,
   * exactly like `form` and `hideLabel`; nothing sets it under `--passes=none`.
   */
  | { readonly k: "if"; readonly cfgBlock: BlockId; readonly then: Stmt; readonly else: Stmt; readonly elseIf?: boolean }
  | { readonly k: "break"; readonly label: LabelId }
  | { readonly k: "continue"; readonly label: LabelId }
  | { readonly k: "return"; readonly cfgBlock: BlockId }
  | { readonly k: "throw"; readonly cfgBlock: BlockId }
  | { readonly k: "unreachable" }
  | {
      readonly k: "switch";
      readonly cfgBlock: BlockId;
      readonly scrutinee: Scrutinee;
      readonly cases: readonly SwitchArm[];
      readonly default: Stmt;
    }
  /**
   * Exception region. Carved by spec 03, wrapped here, never inferred.
   * `cfgBlock` is the synthetic try-head node (§4.5 note below).
   *
   * `shape` (F22-1, docs/specs/passes/22-try-shape-try-clean.md §3.1) is an
   * optional annotation `src/passes/try-shape` writes and the emitter
   * (`src/emit/function.ts`) reads: it is transparent to verify.ts, exactly
   * like `LoopForm`/`hideLabel`/`elseIf` — the body and handler subtrees it
   * sits on are untouched.
   */
  | { readonly k: "try"; readonly region: number; readonly cfgBlock: BlockId; readonly body: Stmt; readonly handler: Stmt; readonly catchRegister: number; readonly shape?: TryShape }
  /**
   * Assign the §4.4 dispatch variable. Not in spec 04's node list: `dispatch`
   * mode is specified as "rewrite entering edges as `__state0 = k; continue L`",
   * which the listed nodes cannot express. `value` is the **block id** the state
   * selects, so verify.ts can resolve a dispatch jump exactly. Contributes no
   * block and no edge of its own.
   */
  | { readonly k: "setState"; readonly variable: DispatchVar; readonly value: number };

/** See the `loop` node. Written by src/passes, read by src/emit. */
export interface LoopForm {
  /** "while": the test runs before every iteration; "do-while": after. */
  readonly kind: "while" | "do-while";
  /** The `if` block (inside `body`) whose terminator is the test. */
  readonly cond: BlockId;
  /**
   * Where the guarded `if` sits: "head" = `block cond; if cond { break L } else { body… }`
   * is the first thing in the loop; "tail" = `…; block cond; if cond { continue L } else { break L }`
   * is the last. (A two-statement body is otherwise ambiguous.)
   */
  readonly at: "head" | "tail";
  /** True when the taken edge of `cond` leaves the loop (print `!c`). */
  readonly negate: boolean;
  /**
   * for-header (src/passes/for-header): `init` = instructions [from, end) of
   * the `block` sibling immediately preceding the loop; `step` = instructions
   * [from, end) of a body block. The emitter prints `for (init; c; step)` only
   * when it finds both exactly where declared, else it falls back to `while`.
   */
  readonly init?: { readonly cfgBlock: BlockId; readonly from: number };
  readonly step?: { readonly cfgBlock: BlockId; readonly from: number };
  /**
   * `for-in`/`for-of` (spec `docs/specs/passes/01-framework-fixes.md` F5):
   * `iterBlock` is the block holding the per-iteration advance-and-test
   * (`GetNextPName`/`IteratorNext` followed by the exhaustion jump);
   * `close` names blocks that are the compiler's iterator-protocol cleanup
   * (`for-of`'s `break`/exception `IteratorClose`), implied by the `for...of`
   * form and dropped rather than printed. The emitter prints `for (k in o)` /
   * `for (v of it)` only when it finds `iterBlock` exactly where declared,
   * else it falls back to `while`, exactly as `init`/`step` do. Nothing sets
   * it in batch 1.
   */
  readonly iter?: { readonly kind: "for-in" | "for-of"; readonly iterBlock: BlockId; readonly close: readonly BlockId[] };
}

/** See the `try` node's `shape` field. Written by `src/passes/try-shape`,
 *  read by `src/emit/function.ts`'s `planTries`/`case "try"` lowering
 *  (docs/specs/passes/22-try-shape-try-clean.md §3.1). */
export interface TryShape {
  /** No instruction in the handler reads `catchRegister`: the handler needs
   *  no `__exc = e` copy and no catch binding. */
  readonly bindsExc: boolean;
  /** `"redundant"`: the emitter's `__pc` range guard is provably always true
   *  when the handler runs, so it may be omitted. `"needed"` is the default
   *  and an absent `shape` means the same. */
  readonly guard: "needed" | "redundant";
}

export type Scrutinee =
  | { readonly t: "jumptable"; readonly table: SwitchTable }
  | { readonly t: "dispatch"; readonly variable: DispatchVar }
  /** spec 03 §4.5's synthetic resume dispatcher: the scrutinee is the shim's `__state`. */
  | { readonly t: "generator-state" };

export interface SwitchArm {
  readonly value: number;
  readonly isString: boolean;
  readonly body: Stmt;
  /**
   * F12 (docs/specs/passes/10-switch-raise.md §5): set by `switch-raise` on an
   * arm whose body deliberately falls into the *next* arm (source-level
   * `case a: … case b:` fall-through). The emitter then skips the `break;` it
   * otherwise appends to every arm. Unlike `form`/`hideLabel`/`elseIf` this is
   * NOT transparent to verify.ts: an arm that falls through continues into the
   * next arm's body, and `reconstruct` models exactly that. Nothing sets it
   * under `--passes=none`, so the baseline is byte-identical (PL-05).
   */
  readonly fallThrough?: boolean;
}

export interface DispatchVar {
  readonly id: number;
}

export interface LabelInfo {
  readonly id: LabelId;
  readonly kind: "block" | "loop";
  readonly header: BlockId;
  readonly usedBy: readonly ("break" | "continue")[];
}

export interface StructureStats {
  readonly blocks: number;
  readonly duplicated: number;
  readonly dispatchVars: number;
  readonly maxNesting: number;
  readonly labels: number;
  readonly expansion: number;
}

export interface StructuredFunction {
  readonly functionIndex: number;
  readonly root: Stmt;
  readonly labels: readonly LabelInfo[];
  readonly dispatchVars: readonly DispatchVar[];
  readonly duplicatedBlocks: readonly BlockId[];
  /** The graph the tree was built from (§4.5's try-head augmentation of `cfg`). */
  readonly graph: AugmentedCfg;
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: StructureStats;
}

// ---------------------------------------------------------------------------
// The augmented graph (§4.5)
// ---------------------------------------------------------------------------

/**
 * Exception regions are turned into ordinary two-way branches before Ramsey
 * runs: each region gets a synthetic **try-head** node whose two successors are
 * the region's body entry and its handler block, and every edge that entered the
 * body from outside is redirected to it. Ramsey then structures the try-head
 * exactly like an `if`, and the join after the `try` falls out as an ordinary
 * merge point — no special case anywhere in the core.
 *
 * A handler shared by several regions (the v99 norm — `hermes-dec-sample`
 * function 5 shares one handler across all five) simply becomes a merge point
 * with one predecessor per try-head, so each `catch` clause `break`s to it and
 * the handler body is emitted once. The exception value travels through the
 * emitter's per-function `__exc` variable, which is what `Catch` reads.
 */
export interface AugmentedCfg {
  readonly cfg: FunctionCfg;
  /** Original blocks followed by the synthetic try-heads. */
  readonly blocks: readonly AugBlock[];
  readonly entry: BlockId;
  readonly preds: readonly (readonly BlockId[])[];
  readonly rpo: readonly BlockId[];
  readonly rpoIndex: readonly number[];
  readonly idom: readonly (BlockId | null)[];
  readonly domChildren: readonly (readonly BlockId[])[];
  dominates(a: BlockId, b: BlockId): boolean;
  readonly backEdges: ReadonlySet<string>;
  readonly loopHeaders: ReadonlySet<BlockId>;
  readonly mergePoints: ReadonlySet<BlockId>;
  /** try-head id -> region index. */
  readonly tryHeads: ReadonlyMap<BlockId, number>;
  readonly reducible: boolean;
}

export type AugTerminator = BasicBlock["terminator"] | { readonly kind: "try"; readonly region: number };

export interface AugBlock {
  readonly id: BlockId;
  /** Null for a synthetic try-head. */
  readonly block: BasicBlock | null;
  readonly terminator: AugTerminator;
  readonly succs: readonly Edge[];
}

export function edgeKey(from: BlockId, to: BlockId): string {
  return `${from}>${to}`;
}

/** Flattening constructor: nested `seq`s are spliced, so tree depth stays low. */
export function seq(parts: readonly Stmt[]): Stmt {
  const out: Stmt[] = [];
  for (const p of parts) {
    if (p.k === "seq") out.push(...p.body);
    else out.push(p);
  }
  if (out.length === 1) return out[0]!;
  return { k: "seq", body: out };
}

export const EMPTY: Stmt = { k: "seq", body: [] };

/** Iterative depth measurement (no recursion over the tree). */
export function maxNesting(root: Stmt): number {
  let max = 0;
  const stack: { node: Stmt; depth: number }[] = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > max) max = depth;
    for (const child of children(node)) stack.push({ node: child, depth: depth + 1 });
  }
  return max;
}

export function children(node: Stmt): readonly Stmt[] {
  switch (node.k) {
    case "seq":
      return node.body;
    case "labeled":
    case "loop":
      return [node.body];
    case "if":
      return [node.then, node.else];
    case "switch":
      return [...node.cases.map((c) => c.body), node.default];
    case "try":
      return [node.body, node.handler];
    default:
      return [];
  }
}
