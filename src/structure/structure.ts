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

  const blockLeaf = (b: AugBlock): Stmt => {
    emitted++;
    if (emitted > budget) throw new NeedDispatch(`expansion budget ${budget} exceeded`);
    return { k: "block", cfgBlock: b.id };
  };

  const doTree = (node: BlockId, ctx: readonly Frame[]): Stmt => {
    enter();
    try {
      if (onPath.has(node)) {
        // Only reachable through §4.4's `duplicate` resolution; a second copy of
        // a node already on the path would not terminate.
        throw new NeedDispatch(`duplication re-entered block ${node}`);
      }
      onPath.add(node);
      try {
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
          return { k: "loop", label, body: nodeWithin(node, mergeKids, 0, inner) };
        }
        return nodeWithin(node, mergeKids, 0, ctx);
      } finally {
        onPath.delete(node);
      }
    } finally {
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

  const doBranch = (from: BlockId, to: BlockId, ctx: readonly Frame[]): Stmt => {
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
      return doTree(to, ctx);
    }
    return doTree(to, ctx);
  };

  const root = doTree(graph.entry, []);

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
// §4.4 `dispatch` mode — never blows up, and unlike a whole-function
// `for(;;) switch(pc)` it keeps `try`/`catch` lexical: one dispatch loop per
// exception scope, all sharing one state variable. An edge leaving a scope sets
// the state and `break`s out of that scope's loop; the enclosing loop picks it up.
// ---------------------------------------------------------------------------

export function dispatchStructure(graph: AugmentedCfg): CoreResult {
  const variable: DispatchVar = { id: 0 };
  const labels: LabelInfo[] = [];
  let nextLabel = 0;

  // scopeOf(block) = the innermost region whose body contains it; try-heads
  // belong to their region's *parent* scope (that is where their edges come from).
  const regions = graph.cfg.regions;
  const scopeOf = new Map<BlockId, number>(); // block -> region index, or -1 for root
  for (const b of graph.blocks) {
    if (b.block === null) continue;
    let innermost = -1;
    for (const r of regions) {
      if (!r.bodyBlocks.has(b.id)) continue;
      if (innermost === -1 || (regions[innermost]!.endPc - regions[innermost]!.startPc) > r.endPc - r.startPc) innermost = r.index;
    }
    scopeOf.set(b.id, innermost);
  }
  for (const [head, regionIndex] of graph.tryHeads) scopeOf.set(head, regions[regionIndex]!.parent ?? -1);

  const reachable = new Set<BlockId>([graph.entry]);
  {
    const stack = [graph.entry];
    while (stack.length > 0) {
      const b = stack.pop()!;
      for (const e of graph.blocks[b]!.succs) if (!reachable.has(e.to)) (reachable.add(e.to), stack.push(e.to));
    }
  }

  const membersOf = new Map<number, BlockId[]>();
  for (const b of graph.blocks) {
    if (!reachable.has(b.id)) continue;
    const s = scopeOf.get(b.id);
    if (s === undefined) continue;
    const list = membersOf.get(s);
    if (list === undefined) membersOf.set(s, [b.id]);
    else list.push(b.id);
  }
  for (const l of membersOf.values()) l.sort((a, b) => a - b);

  const goTo = (target: BlockId, loopLabel: LabelId, scope: number): Stmt => {
    const targetScope = scopeOf.get(target) ?? -1;
    const set: Stmt = { k: "setState", variable, value: target };
    if (targetScope === scope) {
      labelUse(loopLabel, "continue");
      return seq([set, { k: "continue", label: loopLabel }]);
    }
    labelUse(loopLabel, "break");
    return seq([set, { k: "break", label: loopLabel }]);
    // (`set` carries the target block id, which is what makes verify.ts able to
    //  resolve a dispatch jump exactly instead of over-approximating it.)
  };

  const uses = new Map<LabelId, Set<"break" | "continue">>();
  function labelUse(l: LabelId, how: "break" | "continue"): void {
    let s = uses.get(l);
    if (s === undefined) {
      s = new Set();
      uses.set(l, s);
    }
    s.add(how);
  }

  const buildScope = (scope: number, header: BlockId): Stmt => {
    const label = nextLabel++;
    uses.set(label, new Set());
    const members = membersOf.get(scope) ?? [];
    const cases: SwitchArm[] = [];
    for (const id of members) {
      const b = graph.blocks[id]!;
      cases.push({ value: id, isString: false, body: armFor(b, label, scope) });
    }
    labelUse(label, "break");
    const body: Stmt = {
      k: "switch",
      cfgBlock: -1,
      scrutinee: { t: "dispatch", variable },
      cases,
      default: { k: "break", label },
    };
    labels.push({ id: label, kind: "loop", header, usedBy: [] });
    return { k: "loop", label, body };
  };

  const armFor = (b: AugBlock, label: LabelId, scope: number): Stmt => {
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
        return seq([leaf, goTo(b.succs[0]!.to, label, scope)]);
      case "branch": {
        const taken = b.succs.find((e: Edge) => e.kind === "branch-taken")!;
        const notTaken = b.succs.find((e: Edge) => e.kind === "branch-not-taken");
        return seq([leaf, { k: "if", cfgBlock: b.id, then: goTo(taken.to, label, scope), else: notTaken === undefined ? EMPTY : goTo(notTaken.to, label, scope) }]);
      }
      case "switch": {
        const cases: SwitchArm[] = [];
        let dflt: Stmt = EMPTY;
        for (const e of b.succs) {
          if (e.kind === "switch-default") dflt = goTo(e.to, label, scope);
          else cases.push({ value: e.caseValue ?? 0, isString: e.caseIsString === true, body: goTo(e.to, label, scope) });
        }
        const scrutinee = t.synthetic === true ? ({ t: "generator-state" } as const) : ({ t: "jumptable", table: t.table } as const);
        return seq([leaf, { k: "switch", cfgBlock: b.id, scrutinee, cases, default: dflt }]);
      }
      case "try": {
        const region = graph.cfg.regions[t.region]!;
        const bodyEntry = b.succs[0]!.to;
        const handler = b.succs[1]!.to;
        const inner = seq([{ k: "setState", variable, value: bodyEntry }, buildScope(t.region, bodyEntry)]);
        // The inner loop `break`s out with the state already set; re-dispatching
        // through this scope's own switch either finds the target here or hits
        // `default: break` and propagates the state one scope further out.
        labelUse(label, "continue");
        return seq([
          { k: "try", region: t.region, cfgBlock: b.id, body: inner, handler: goTo(handler, label, scope), catchRegister: region.catchRegister },
          { k: "continue", label },
        ]);
      }
    }
  };

  const root = seq([{ k: "setState", variable, value: graph.entry }, buildScope(-1, graph.entry)]);
  const finalLabels = labels.map((l) => ({ ...l, usedBy: [...(uses.get(l.id) ?? [])].sort() }));
  return { root, labels: finalLabels, duplicatedBlocks: [], emitted: reachable.size, diagnostics: [] };
}
