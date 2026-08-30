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
  /** `label: while (true) { body }`. */
  | { readonly k: "loop"; readonly label: LabelId; readonly body: Stmt }
  /** Two-way branch on the terminator of `cfgBlock`. */
  | { readonly k: "if"; readonly cfgBlock: BlockId; readonly then: Stmt; readonly else: Stmt }
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
   */
  | { readonly k: "try"; readonly region: number; readonly cfgBlock: BlockId; readonly body: Stmt; readonly handler: Stmt; readonly catchRegister: number }
  /**
   * Assign the §4.4 dispatch variable. Not in spec 04's node list: `dispatch`
   * mode is specified as "rewrite entering edges as `__state0 = k; continue L`",
   * which the listed nodes cannot express. `value` is the **block id** the state
   * selects, so verify.ts can resolve a dispatch jump exactly. Contributes no
   * block and no edge of its own.
   */
  | { readonly k: "setState"; readonly variable: DispatchVar; readonly value: number };

export type Scrutinee =
  | { readonly t: "jumptable"; readonly table: SwitchTable }
  | { readonly t: "dispatch"; readonly variable: DispatchVar }
  /** spec 03 §4.5's synthetic resume dispatcher: the scrutinee is the shim's `__state`. */
  | { readonly t: "generator-state" };

export interface SwitchArm {
  readonly value: number;
  readonly isString: boolean;
  readonly body: Stmt;
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
