// docs/specs/04-structurer.md §4 — Ramsey (ICFP'22), the total core.
//
// One recursive pass over the dominator tree of the *augmented* graph
// (augment.ts turns each exception region into an ordinary two-way branch), with
// immutable data. §4.4's irreducibility handling is reached exactly when
// `doBranch` wants to break to a merge point whose label is not in scope — there
// is no separate irreducibility analysis, deliberately.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { Diagnostic } from "../errors.ts";
import type { BlockId, Edge } from "../cfg/types.ts";
import { EMPTY, seq } from "./ir.ts";
import type { AugBlock, AugmentedCfg, DispatchVar, LabelId, LabelInfo, Stmt, SwitchArm } from "./ir.ts";
import { edgeKey } from "./ir.ts";

export interface CoreOptions {
  readonly maxExpansion: number;
  readonly maxDepth: number;
}

/** Thrown internally when `duplicate` mode would blow up; `auto` catches it. */
export class NeedDispatch extends Error {
  readonly why: string;
  constructor(why: string) {
    super(why);
    this.name = "NeedDispatch";
    this.why = why;
  }
}

interface Frame {
  readonly kind: "block" | "loop";
  readonly header: BlockId;
  readonly label: LabelId;
}

export interface CoreResult {
  readonly root: Stmt;
  readonly labels: readonly LabelInfo[];
  readonly duplicatedBlocks: readonly BlockId[];
  readonly emitted: number;
  readonly diagnostics: readonly Diagnostic[];
}

export function ramsey(graph: AugmentedCfg, opts: CoreOptions): CoreResult {
  const labelOfHeader = new Map<BlockId, LabelId>();
  const labelKind = new Map<LabelId, "block" | "loop">();
  const labelUses = new Map<LabelId, Set<"break" | "continue">>();
  const duplicated = new Set<BlockId>();
  const diagnostics: Diagnostic[] = [];
  let emitted = 0;
  let depth = 0;
  const onPath = new Set<BlockId>();

  const budget = Math.max(64, Math.ceil(graph.blocks.length * opts.maxExpansion));

  const labelFor = (header: BlockId, kind: "block" | "loop"): LabelId => {
    const hit = labelOfHeader.get(header);
    if (hit !== undefined) return hit;
    const id = labelOfHeader.size;
    labelOfHeader.set(header, id);
    labelKind.set(id, kind);
    labelUses.set(id, new Set());
    return id;
  };
  const use = (label: LabelId, how: "break" | "continue"): void => {
    labelUses.get(label)?.add(how);
  };

  const enter = (): void => {
    if (++depth > opts.maxDepth) {
      throw new Hbc2jsError(ErrorCode.E_TOO_COMPLEX, `structurer recursion exceeded ${opts.maxDepth} levels`, { functionIndex: graph.cfg.functionIndex, section: "structure" });
    }
  };
  const leave = (): void => {
    depth--;
  };

  const seenBlocks = new Set<BlockId>();
  const blockLeaf = (b: AugBlock): Stmt => {
    emitted++;
    if (emitted > budget) throw new NeedDispatch(`expansion budget ${budget} exceeded`);
    // P3 counts *every* repeated block, not just the node §4.4 split: resolving
    // one irreducible entry duplicates the whole subtree below it.
    if (seenBlocks.has(b.id)) duplicated.add(b.id);
    else seenBlocks.add(b.id);
    return { k: "block", cfgBlock: b.id };
  };

  // A `doTree` frame is spent on *nesting*, never on length. A flat chain of
  // blocks (`jump`/`fallthrough` terminators with nothing to nest under them)
  // is walked iteratively in the loop below, so a chain of any length costs one
  // native frame and one unit of `depth`, and `maxDepth` measures what it says
  // it measures. Genuine nesting -- branch arms, switch arms, try bodies, merge
  // kids, loop bodies -- still recurses, and is still what `maxDepth` guards.
  // See docs/DECISIONS.md (D-STRUCT-CHAIN). Output is unchanged: `seq` flattens
  // nested `seq` nodes, so accumulating the chain's leaves into one list builds
  // exactly the tree the nested form built.
  const doTree = (start: BlockId, ctx: readonly Frame[]): Stmt => {
    enter();
    const entered: BlockId[] = [];
    try {
      const parts: Stmt[] = [];
      let node = start;
      for (;;) {
        if (onPath.has(node)) {
          // Only reachable through §4.4's `duplicate` resolution; a second copy of
          // a node already on the path would not terminate.
          throw new NeedDispatch(`duplication re-entered block ${node}`);
        }
        onPath.add(node);
        entered.push(node);
        const kids = graph.domChildren[node]!; // already sorted descending by RPO (§4.3)
        const mergeKids = kids.filter((k) => graph.mergePoints.has(k));
        // The `loop` wrapper goes *outside* the merge-kid nesting, and the loop
        // frame is in scope for the merge kids' own subtrees. Spec 04 §4.2's
        // paraphrase puts the loop in `nodeWithin(node, [], …)`'s base case,
        // which places the merge kids outside the loop — and then the back edge
        // from a merge kid (the common shape of `02-while-loop`: the latch block
        // is a merge kid of the header) has no enclosing loop label and the
        // function falls all the way through to dispatch mode. Ramsey's paper
        // has it the other way round; this follows the paper.
        if (graph.loopHeaders.has(node)) {
          const label = labelFor(node, "loop");
          const inner = ctx.concat([{ kind: "loop", header: node, label }]);
          parts.push({ k: "loop", label, body: nodeWithin(node, mergeKids, 0, inner) });
          break;
        }
        if (mergeKids.length > 0) {
          parts.push(nodeWithin(node, mergeKids, 0, ctx));
          break;
        }
        const block = graph.blocks[node]!;
        const t = block.terminator;
        if (t.kind === "jump" || t.kind === "fallthrough") {
          // `bodyOf`'s jump case, unrolled: leaf first (its `emitted`/budget
          // side effects keep their order), then the successor — and when the
          // successor is another plain subtree, stay in this frame.
          parts.push(blockLeaf(block));
          const next = resolveBranch(block.id, block.succs[0]!.to, ctx);
          if (typeof next === "number") {
            node = next;
            continue;
          }
          parts.push(next);
          break;
        }
        parts.push(bodyOf(block, ctx));
        break;
      }
      return seq(parts);
    } finally {
      for (const n of entered) onPath.delete(n);
      leave();
    }
  };

  const nodeWithin = (node: BlockId, mergeKids: readonly BlockId[], i: number, ctx: readonly Frame[]): Stmt => {
    if (i >= mergeKids.length) return bodyOf(graph.blocks[node]!, ctx);
    const k = mergeKids[i]!;
    const label = labelFor(k, "block");
    const inner = ctx.concat([{ kind: "block", header: k, label }]);
    return seq([{ k: "labeled", label, body: nodeWithin(node, mergeKids, i + 1, inner) }, doTree(k, ctx)]);
  };

  const bodyOf = (block: AugBlock, ctx: readonly Frame[]): Stmt => {
    const leaf = blockLeaf(block);
    const t = block.terminator;
    switch (t.kind) {
      case "return":
        return { k: "return", cfgBlock: block.id };
      case "throw":
        return { k: "throw", cfgBlock: block.id };
      case "unreachable":
        return block.block !== null && block.block.instructions.length > 0 ? seq([leaf, { k: "unreachable" }]) : { k: "unreachable" };
      case "jump":
      case "fallthrough":
        return seq([leaf, doBranch(block.id, block.succs[0]!.to, ctx)]);
      case "branch": {
        const taken = block.succs.find((e) => e.kind === "branch-taken")!;
        const notTaken = block.succs.find((e) => e.kind === "branch-not-taken");
        const thenS = doBranch(block.id, taken.to, ctx);
        const elseS = notTaken === undefined ? EMPTY : doBranch(block.id, notTaken.to, ctx);
        return seq([leaf, { k: "if", cfgBlock: block.id, then: thenS, else: elseS }]);
      }
      case "try": {
        const region = graph.cfg.regions[t.region]!;
        const bodyEdge = block.succs[0]!;
        const handlerEdge = block.succs[1]!;
        const body = doBranch(block.id, bodyEdge.to, ctx);
        const handler = doBranch(block.id, handlerEdge.to, ctx);
        return { k: "try", region: t.region, cfgBlock: block.id, body, handler, catchRegister: region.catchRegister };
      }
      case "switch": {
        const cases: SwitchArm[] = [];
        let dflt: Stmt = EMPTY;
        for (const e of block.succs) {
          if (e.kind === "switch-default") {
            dflt = doBranch(block.id, e.to, ctx);
            continue;
          }
          cases.push({ value: e.caseValue ?? 0, isString: e.caseIsString === true, body: doBranch(block.id, e.to, ctx) });
        }
        const scrutinee = t.synthetic === true ? ({ t: "generator-state" } as const) : ({ t: "jumptable", table: t.table } as const);
        return seq([leaf, { k: "switch", cfgBlock: block.id, scrutinee, cases, default: dflt }]);
      }
    }
  };

  /**
   * Where a branch to `to` goes: a finished `Stmt` (`continue`/`break`), or the
   * block id of a subtree still to be built. Returning the id rather than
   * building it lets `doTree` continue a flat chain without recursing.
   */
  const resolveBranch = (from: BlockId, to: BlockId, ctx: readonly Frame[]): Stmt | BlockId => {
    if (graph.backEdges.has(edgeKey(from, to))) {
      const frame = [...ctx].reverse().find((f) => f.header === to && f.kind === "loop");
      if (frame === undefined) throw new NeedDispatch(`back edge ${from}->${to} has no enclosing loop label`);
      use(frame.label, "continue");
      return { k: "continue", label: frame.label };
    }
    if (graph.mergePoints.has(to)) {
      const frame = [...ctx].reverse().find((f) => f.header === to);
      if (frame !== undefined) {
        use(frame.label, "break");
        return { k: "break", label: frame.label };
      }
      // §4.4 — irreducible. Discovered here, by a failed label lookup, and
      // nowhere else. `duplicate` resolves it by splitting the node.
      duplicated.add(to);
    }
    return to;
  };

  const doBranch = (from: BlockId, to: BlockId, ctx: readonly Frame[]): Stmt => {
    const r = resolveBranch(from, to, ctx);
    return typeof r === "number" ? doTree(r, ctx) : r;
  };

  // The only place a host stack overflow is converted. Genuine nesting is
  // guarded by `maxDepth`, but the number of native frames one nesting level
  // costs is a property of the host, not of this code, so on a small or
  // already-deep stack V8 can run out first. Anywhere else this catch would be
  // unsound (it could swallow an overflow raised by unrelated code and leave a
  // half-built tree in play); at the entry point the stack is fully unwound and
  // nothing of the failed attempt survives.
  let root: Stmt;
  try {
    root = doTree(graph.entry, []);
  } catch (e) {
    if (e instanceof RangeError && e.message.includes("Maximum call stack size exceeded")) {
      throw new Hbc2jsError(ErrorCode.E_TOO_COMPLEX, "structurer exhausted the host call stack before the recursion guard fired", { functionIndex: graph.cfg.functionIndex, section: "structure" });
    }
    throw e;
  }


  const labels: LabelInfo[] = [];
  for (const [header, id] of labelOfHeader) {
    labels.push({ id, kind: labelKind.get(id)!, header, usedBy: [...(labelUses.get(id) ?? [])].sort() });
  }
  labels.sort((a, b) => a.id - b.id);
  for (const l of labels) {
    if (l.usedBy.length === 0) diagnostics.push({ severity: "warn", code: "W_UNUSED_LABEL", message: `label L${l.id} (block ${l.header}) is never used`, context: { functionIndex: graph.cfg.functionIndex } });
  }

  return { root, labels, duplicatedBlocks: [...duplicated].sort((a, b) => a - b), emitted, diagnostics };
}

// ---------------------------------------------------------------------------
// §4.4 `dispatch` mode — total, and never blows up.
//
// One flat `switch (__state)` over every reachable block, wrapped in a nest of
// `try` nodes, one per exception region, innermost first. Each `catch` is guarded
// by the emitter's `__pc` check (which records the block that is executing), so
// an exception is routed to exactly the region that covers the block that threw
// and rethrown otherwise. That is what makes the flat form correct in the
// presence of exceptions, where the obvious `for(;;) switch(pc)` is not: a
// `continue` out of a `try` leaves it, so the protected extent has to be
// re-entered on every step rather than spanned once.
//
// The graph the tree is checked against is the *plain* CFG (no try-heads):
// every block's outgoing edge is `setState(target); continue L`, whose target
// verify.ts resolves exactly, and a handler is entered only through a `catch`,
// which contributes no normal edge — precisely the CFG's own model.
// ---------------------------------------------------------------------------

export function dispatchStructure(graph: AugmentedCfg): CoreResult {
  const variable: DispatchVar = { id: 0 };
  const label: LabelId = 0;
  const uses = new Set<"break" | "continue">();

  const reachable = new Set<BlockId>([graph.entry]);
  {
    const stack = [graph.entry];
    while (stack.length > 0) {
      const b = stack.pop()!;
      for (const e of graph.blocks[b]!.succs) if (!reachable.has(e.to)) (reachable.add(e.to), stack.push(e.to));
      for (const h of graph.cfg.exceptionSuccs.get(b) ?? []) if (!reachable.has(h)) (reachable.add(h), stack.push(h));
    }
  }

  const goTo = (target: BlockId): Stmt => {
    uses.add("continue");
    return seq([{ k: "setState", variable, value: target }, { k: "continue", label }]);
  };

  const armFor = (b: AugBlock): Stmt => {
    const leaf: Stmt = { k: "block", cfgBlock: b.id };
    const t = b.terminator;
    switch (t.kind) {
      case "return":
        return { k: "return", cfgBlock: b.id };
      case "throw":
        return { k: "throw", cfgBlock: b.id };
      case "unreachable":
        return b.block !== null && b.block.instructions.length > 0 ? seq([leaf, { k: "unreachable" }]) : { k: "unreachable" };
      case "jump":
      case "fallthrough":
        return seq([leaf, goTo(b.succs[0]!.to)]);
      case "branch": {
        const taken = b.succs.find((e: Edge) => e.kind === "branch-taken")!;
        const notTaken = b.succs.find((e: Edge) => e.kind === "branch-not-taken");
        return seq([leaf, { k: "if", cfgBlock: b.id, then: goTo(taken.to), else: notTaken === undefined ? EMPTY : goTo(notTaken.to) }]);
      }
      case "switch": {
        const cases: SwitchArm[] = [];
        let dflt: Stmt = EMPTY;
        for (const e of b.succs) {
          if (e.kind === "switch-default") dflt = goTo(e.to);
          else cases.push({ value: e.caseValue ?? 0, isString: e.caseIsString === true, body: goTo(e.to) });
        }
        const scrutinee = t.synthetic === true ? ({ t: "generator-state" } as const) : ({ t: "jumptable", table: t.table } as const);
        return seq([leaf, { k: "switch", cfgBlock: b.id, scrutinee, cases, default: dflt }]);
      }
      case "try":
        // Only reachable from the Ramsey path's augmentation, which dispatch
        // mode does not use.
        throw new Hbc2jsError(ErrorCode.E_INTERNAL, "dispatch mode saw a synthetic try-head", { functionIndex: graph.cfg.functionIndex, section: "structure" });
    }
  };

  const members = [...reachable].sort((a, b) => a - b);
  const flat: Stmt = {
    k: "switch",
    cfgBlock: -1,
    scrutinee: { t: "dispatch", variable },
    cases: members.map((id) => ({ value: id, isString: false, body: armFor(graph.blocks[id]!) })),
    default: { k: "unreachable" },
  };

  // Innermost region first, so an exception is offered to the tightest handler
  // that could own it before any enclosing one.
  const depthOf = (index: number): number => {
    let d = 0;
    let p = graph.cfg.regions[index]!.parent;
    while (p !== null) {
      d++;
      p = graph.cfg.regions[p]!.parent;
    }
    return d;
  };
  const ordered = graph.cfg.regions.map((r) => r.index).sort((a, b) => depthOf(b) - depthOf(a) || a - b);
  let body: Stmt = flat;
  for (const index of ordered) {
    const region = graph.cfg.regions[index]!;
    body = { k: "try", region: index, cfgBlock: -1, body, handler: goTo(region.handlerBlock), catchRegister: region.catchRegister };
  }

  const root = seq([{ k: "setState", variable, value: graph.entry }, { k: "loop", label, body }]);
  return {
    root,
    labels: [{ id: label, kind: "loop", header: graph.entry, usedBy: [...uses].sort() }],
    duplicatedBlocks: [],
    emitted: reachable.size,
    diagnostics: [],
  };
}
