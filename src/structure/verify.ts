// docs/specs/04-structurer.md §5 — the proof obligation. The tree must round-trip
// to a graph isomorphic to the one it was built from.
//
// Written before the core (§10 "Sequence: write verify.ts first"), and run inline
// for every function by default. P1 is the one that matters and it is cheap: one
// extra tree walk.
//
// Transparent annotations: `loop.form`, `loop.hideLabel` and `if.elseIf`
// (spec 07 / specs/passes/01 F9 / specs/passes/09 F11) are never read here —
// the annotated jumps and branches stay in the tree, so the round-trip proves
// an annotated tree exactly as it proves a bare one.
import type { BlockId } from "../cfg/types.ts";
import { children, edgeKey } from "./ir.ts";
import type { AugmentedCfg, LabelId, Stmt, StructuredFunction } from "./ir.ts";

export interface ReconstructedCfg {
  /** In emission order, with duplicates. */
  readonly blocks: readonly BlockId[];
  readonly edges: readonly (readonly [BlockId, BlockId])[];
  /** Labels named by a break/continue that was not in scope at that point (P4). */
  readonly unscopedLabels: readonly LabelId[];
  /** `continue` naming a non-loop label (P4). */
  readonly badContinues: readonly LabelId[];
}

export type CheckResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly missingEdges: readonly (readonly [BlockId, BlockId])[];
      readonly extraEdges: readonly (readonly [BlockId, BlockId])[];
    };

interface LabelBinding {
  readonly id: LabelId;
  readonly kind: "block" | "loop";
  /** Where control goes on `break label`. */
  readonly brk: () => ReadonlySet<BlockId>;
  /** Where control goes on `continue label`. Only for loops. */
  readonly cont: (() => ReadonlySet<BlockId>) | null;
}

const EMPTY_SET: ReadonlySet<BlockId> = new Set<BlockId>();

/**
 * Interpret the tree abstractly: resolve every `break`/`continue` to the block
 * control actually reaches, and collect the induced edge set.
 *
 * `entry(stmt)` is the set of CFG blocks control can be *at* when the statement
 * begins. It is computed lazily (thunks) because a `loop`'s body continues into
 * the loop head, and memoised so the laziness terminates.
 */
export function reconstruct(fn: StructuredFunction): ReconstructedCfg {
  const order: BlockId[] = [];
  const edges: [BlockId, BlockId][] = [];
  const unscopedLabels: LabelId[] = [];
  const badContinues: LabelId[] = [];
  const deferred: { from: BlockId; next: () => ReadonlySet<BlockId> }[] = [];

  const memo = <T>(f: () => T): (() => T) => {
    let done = false;
    let value: T;
    let running = false;
    return (): T => {
      if (done) return value;
      if (running) return EMPTY_SET as unknown as T; // cycle guard; see P7
      running = true;
      value = f();
      running = false;
      done = true;
      return value;
    };
  };

  const union = (...sets: ReadonlySet<BlockId>[]): ReadonlySet<BlockId> => {
    const out = new Set<BlockId>();
    for (const s of sets) for (const v of s) out.add(v);
    return out;
  };

  const walk = (stmt: Stmt, after: () => ReadonlySet<BlockId>, ctx: readonly LabelBinding[]): (() => ReadonlySet<BlockId>) => {
    switch (stmt.k) {
      case "block": {
        order.push(stmt.cfgBlock);
        deferred.push({ from: stmt.cfgBlock, next: after });
        const s: ReadonlySet<BlockId> = new Set([stmt.cfgBlock]);
        return () => s;
      }
      case "return":
      case "throw": {
        order.push(stmt.cfgBlock);
        const s: ReadonlySet<BlockId> = new Set([stmt.cfgBlock]);
        return () => s;
      }
      case "unreachable":
        return () => EMPTY_SET;
      case "setState": {
        // §4.4's dispatch encoding: `value` is the *block id* the state selects,
        // so control provably continues there rather than at any arm of the
        // enclosing switch. Resolving it exactly is what keeps P1 an equality
        // rather than an over-approximation.
        const s: ReadonlySet<BlockId> = new Set([stmt.value]);
        return () => s;
      }
      case "seq": {
        let acc = after;
        for (let i = stmt.body.length - 1; i >= 0; i--) acc = walk(stmt.body[i]!, acc, ctx);
        return acc;
      }
      case "labeled": {
        const binding: LabelBinding = { id: stmt.label, kind: "block", brk: after, cont: null };
        return walk(stmt.body, after, [...ctx, binding]);
      }
      case "loop": {
        let bodyEntry: (() => ReadonlySet<BlockId>) | null = null;
        const self = memo((): ReadonlySet<BlockId> => (bodyEntry === null ? EMPTY_SET : bodyEntry()));
        const binding: LabelBinding = { id: stmt.label, kind: "loop", brk: after, cont: self };
        bodyEntry = walk(stmt.body, self, [...ctx, binding]);
        return self;
      }
      case "if": {
        const t = walk(stmt.then, after, ctx);
        const e = walk(stmt.else, after, ctx);
        return memo(() => union(t(), e()));
      }
      case "switch": {
        const arms = stmt.cases.map((c) => walk(c.body, after, ctx));
        const d = walk(stmt.default, after, ctx);
        return memo(() => union(...arms.map((a) => a()), d()));
      }
      case "try": {
        // The try-head is a synthetic block with two outgoing edges (body,
        // handler); both are real edges of the augmented graph, so both must be
        // reconstructed here — the `try` node is the only place they appear.
        // §4.4's dispatch nest has no try-head (`cfgBlock: -1`): its `catch`
        // contributes no *normal* edge, which is exactly the CFG's own model of
        // an exception edge.
        const body = walk(stmt.body, after, ctx);
        const handler = walk(stmt.handler, after, ctx);
        if (stmt.cfgBlock < 0) return body;
        order.push(stmt.cfgBlock);
        deferred.push({ from: stmt.cfgBlock, next: body });
        deferred.push({ from: stmt.cfgBlock, next: handler });
        const s: ReadonlySet<BlockId> = new Set([stmt.cfgBlock]);
        return () => s;
      }
      case "break": {
        const b = [...ctx].reverse().find((x) => x.id === stmt.label);
        if (b === undefined) {
          unscopedLabels.push(stmt.label);
          return () => EMPTY_SET;
        }
        return b.brk;
      }
      case "continue": {
        const b = [...ctx].reverse().find((x) => x.id === stmt.label);
        if (b === undefined) {
          unscopedLabels.push(stmt.label);
          return () => EMPTY_SET;
        }
        if (b.cont === null) {
          badContinues.push(stmt.label);
          return () => EMPTY_SET;
        }
        return b.cont;
      }
    }
  };

  walk(fn.root, () => EMPTY_SET, []);
  for (const d of deferred) for (const to of d.next()) edges.push([d.from, to]);

  return { blocks: order, edges, unscopedLabels, badContinues };
}

/** §5 P1–P7. */
export function checkIsomorphic(fn: StructuredFunction, rec: ReconstructedCfg): CheckResult {
  const graph: AugmentedCfg = fn.graph;

  // P4 — label scoping.
  if (rec.unscopedLabels.length > 0) {
    return { ok: false, reason: `P4: break/continue names label(s) not in scope: ${[...new Set(rec.unscopedLabels)].join(", ")}`, missingEdges: [], extraEdges: [] };
  }
  if (rec.badContinues.length > 0) {
    return { ok: false, reason: `P4: continue names a non-loop label: ${[...new Set(rec.badContinues)].join(", ")}`, missingEdges: [], extraEdges: [] };
  }

  // Only reachable blocks are in scope for P1/P2 — an unreachable CFG block
  // (dead code after a Ret) is legitimately absent from the tree. Reachability
  // is over normal *and* exception edges, matching spec 03's CFG-05: a handler
  // block has no normal predecessor but its own outgoing edges are real.
  const reachable = new Set<BlockId>();
  {
    const stack: BlockId[] = [graph.entry];
    reachable.add(graph.entry);
    while (stack.length > 0) {
      const b = stack.pop()!;
      for (const e of graph.blocks[b]!.succs) if (!reachable.has(e.to)) (reachable.add(e.to), stack.push(e.to));
      for (const h of graph.cfg.exceptionSuccs.get(b) ?? []) if (!reachable.has(h)) (reachable.add(h), stack.push(h));
    }
  }

  // P1 — edge preservation.
  const want = new Set<string>();
  for (const b of graph.blocks) {
    if (!reachable.has(b.id)) continue;
    for (const e of b.succs) want.add(edgeKey(e.from, e.to));
  }
  const got = new Set<string>();
  for (const [from, to] of rec.edges) got.add(edgeKey(from, to));

  const missing: [BlockId, BlockId][] = [];
  const extra: [BlockId, BlockId][] = [];
  for (const k of want) if (!got.has(k)) missing.push(parseKey(k));
  for (const k of got) if (!want.has(k)) extra.push(parseKey(k));
  if (missing.length > 0 || extra.length > 0) {
    return { ok: false, reason: `P1: reconstructed edge set differs (${missing.length} missing, ${extra.length} extra)`, missingEdges: missing, extraEdges: extra };
  }

  // P2 — block coverage.
  const seen = new Set(rec.blocks);
  const uncovered = [...reachable].filter((b) => !seen.has(b));
  if (uncovered.length > 0) {
    return { ok: false, reason: `P2: ${uncovered.length} reachable block(s) never appear in the tree: ${uncovered.slice(0, 8).join(", ")}`, missingEdges: [], extraEdges: [] };
  }

  // P3 — no duplicate side effects without declared duplication.
  const counts = new Map<BlockId, number>();
  for (const b of rec.blocks) counts.set(b, (counts.get(b) ?? 0) + 1);
  const declared = new Set(fn.duplicatedBlocks);
  const undeclared = [...counts.entries()].filter(([b, c]) => c > 1 && !declared.has(b)).map(([b]) => b);
  if (undeclared.length > 0) {
    return { ok: false, reason: `P3: block(s) emitted more than once without being declared duplicated: ${undeclared.slice(0, 8).join(", ")}`, missingEdges: [], extraEdges: [] };
  }

  // P5 — terminator fidelity.
  const shape = new Map<BlockId, string>();
  collectShapes(fn.root, shape);
  for (const b of graph.blocks) {
    if (!reachable.has(b.id)) continue;
    const kind = b.terminator.kind;
    const found = shape.get(b.id);
    if (kind === "branch" && found !== "if") return { ok: false, reason: `P5: block ${b.id} has a branch terminator but the tree has ${found ?? "no"} node for it`, missingEdges: [], extraEdges: [] };
    if (kind === "switch" && found !== "switch") return { ok: false, reason: `P5: block ${b.id} has a switch terminator but the tree has ${found ?? "no"} node for it`, missingEdges: [], extraEdges: [] };
    if (kind === "try" && found !== "try") return { ok: false, reason: `P5: block ${b.id} is a try-head but the tree has ${found ?? "no"} node for it`, missingEdges: [], extraEdges: [] };
    if (kind === "return" && found !== "return") return { ok: false, reason: `P5: block ${b.id} returns but the tree has ${found ?? "no"} node for it`, missingEdges: [], extraEdges: [] };
    if (kind === "throw" && found !== "throw") return { ok: false, reason: `P5: block ${b.id} throws but the tree has ${found ?? "no"} node for it`, missingEdges: [], extraEdges: [] };
  }

  // P6 — region containment.
  for (const [head, regionIndex] of graph.tryHeads) {
    const node = findTry(fn.root, head);
    if (node === null) return { ok: false, reason: `P6: no try node for region ${regionIndex}`, missingEdges: [], extraEdges: [] };
    const inBody = new Set<BlockId>();
    collectBlocks(node.body, inBody);
    const region = graph.cfg.regions[regionIndex]!;
    for (const b of region.bodyBlocks) {
      if (!reachable.has(b)) continue;
      if (!inBody.has(b)) return { ok: false, reason: `P6: block ${b} of region ${regionIndex} is not inside its try body`, missingEdges: [], extraEdges: [] };
    }
  }

  return { ok: true };
}

function parseKey(k: string): [BlockId, BlockId] {
  const i = k.indexOf(">");
  return [Number(k.slice(0, i)), Number(k.slice(i + 1))];
}

function collectShapes(root: Stmt, out: Map<BlockId, string>): void {
  const stack: Stmt[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    // `cfgBlock < 0` is a synthetic node (§4.4's flat dispatch switch and the
    // `try` nest around it), which stands for no CFG block.
    if ((n.k === "if" || n.k === "switch" || n.k === "return" || n.k === "throw" || n.k === "try") && n.cfgBlock >= 0) out.set(n.cfgBlock, n.k);
    for (const c of children(n)) stack.push(c);
  }
}

function collectBlocks(root: Stmt, out: Set<BlockId>): void {
  const stack: Stmt[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.k === "block" || n.k === "return" || n.k === "throw") out.add(n.cfgBlock);
    for (const c of children(n)) stack.push(c);
  }
}

function findTry(root: Stmt, head: BlockId): (Stmt & { k: "try" }) | null {
  const stack: Stmt[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.k === "try" && n.cfgBlock === head) return n;
    for (const c of children(n)) stack.push(c);
  }
  return null;
}
