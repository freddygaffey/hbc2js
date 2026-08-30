// docs/specs/03-cfg.md §4.4 — reverse postorder, Cooper–Harvey–Kennedy iterative
// dominators, back edges, reducibility. Computed over the NORMAL graph only.
// Explicit stacks throughout: a recursive DFS overflows on obfuscated input (§8).
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { BasicBlock, BlockId, DominatorTree } from "./types.ts";

export interface DomResult {
  readonly rpo: readonly BlockId[];
  readonly dom: DominatorTree;
  readonly reducible: boolean;
  readonly unreachable: readonly BlockId[];
}

/** Iterative DFS postorder from `entry` over normal successors. */
function postorder(blocks: readonly BasicBlock[], entry: BlockId): { order: BlockId[]; retreating: [BlockId, BlockId][] } {
  const n = blocks.length;
  const state = new Uint8Array(n); // 0 = unvisited, 1 = on stack, 2 = done
  const order: BlockId[] = [];
  const retreating: [BlockId, BlockId][] = [];
  const stack: BlockId[] = [entry];
  const nextEdge = new Int32Array(n).fill(0);
  state[entry] = 1;

  while (stack.length > 0) {
    const b = stack[stack.length - 1]!;
    const succs = blocks[b]!.succs;
    const i = nextEdge[b]!;
    if (i < succs.length) {
      nextEdge[b] = i + 1;
      const t = succs[i]!.to;
      if (state[t] === 0) {
        state[t] = 1;
        stack.push(t);
      } else if (state[t] === 1) {
        retreating.push([b, t]);
      }
      continue;
    }
    state[b] = 2;
    order.push(b);
    stack.pop();
  }
  return { order, retreating };
}

export function computeDominators(blocks: readonly BasicBlock[], entry: BlockId, functionIndex: number): DomResult {
  const n = blocks.length;
  const { order: po, retreating } = postorder(blocks, entry);
  const rpo = [...po].reverse();

  const rpoIndex = new Int32Array(n).fill(-1);
  for (const [i, b] of rpo.entries()) rpoIndex[b] = i;

  const unreachable: BlockId[] = [];
  for (let b = 0; b < n; b++) if (rpoIndex[b] === -1) unreachable.push(b);

  // Cooper–Harvey–Kennedy over the RPO.
  const idomIdx = new Int32Array(rpo.length).fill(-1);
  idomIdx[0] = 0; // entry dominates itself

  const intersect = (a: number, b: number): number => {
    let x = a;
    let y = b;
    while (x !== y) {
      while (x > y) x = idomIdx[x]!;
      while (y > x) y = idomIdx[y]!;
    }
    return x;
  };

  let changed = true;
  let iterations = 0;
  while (changed) {
    changed = false;
    if (++iterations > rpo.length + 2) {
      throw new Hbc2jsError(ErrorCode.E_INTERNAL, `dominator iteration did not converge in ${rpo.length + 2} passes`, { functionIndex, section: "cfg/dom" });
    }
    for (let i = 1; i < rpo.length; i++) {
      const b = rpo[i]!;
      let newIdom = -1;
      for (const p of blocks[b]!.preds) {
        const pi = rpoIndex[p]!;
        if (pi === -1 || idomIdx[pi] === -1) continue; // unprocessed or unreachable
        newIdom = newIdom === -1 ? pi : intersect(pi, newIdom);
      }
      if (newIdom !== -1 && idomIdx[i] !== newIdom) {
        idomIdx[i] = newIdom;
        changed = true;
      }
    }
  }

  const idom: (BlockId | null)[] = new Array<BlockId | null>(n).fill(null);
  const children: BlockId[][] = blocks.map(() => []);
  for (let i = 1; i < rpo.length; i++) {
    const b = rpo[i]!;
    const d = idomIdx[i];
    if (d === undefined || d === -1) continue;
    const parent = rpo[d]!;
    idom[b] = parent;
    children[parent]!.push(b);
  }
  for (const c of children) c.sort((a, z) => (rpoIndex[a]! - rpoIndex[z]!) || a - z);

  // O(1) `dominates` via a preorder walk of the dominator tree (explicit stack).
  const tin = new Int32Array(n).fill(-1);
  const tout = new Int32Array(n).fill(-1);
  const preorder: BlockId[] = [];
  let clock = 0;
  const walk: { node: BlockId; i: number }[] = [{ node: entry, i: 0 }];
  tin[entry] = clock++;
  preorder.push(entry);
  while (walk.length > 0) {
    const top = walk[walk.length - 1]!;
    const kids = children[top.node]!;
    if (top.i < kids.length) {
      const c = kids[top.i++]!;
      tin[c] = clock++;
      preorder.push(c);
      walk.push({ node: c, i: 0 });
      continue;
    }
    tout[top.node] = clock++;
    walk.pop();
  }

  const dominates = (a: BlockId, b: BlockId): boolean => {
    if (tin[a] === -1 || tin[b] === -1) return false;
    return tin[a]! <= tin[b]! && tout[b]! <= tout[a]!;
  };

  const backEdges: [BlockId, BlockId][] = [];
  for (const b of blocks) {
    for (const e of b.succs) {
      if (dominates(e.to, e.from)) backEdges.push([e.from, e.to]);
    }
  }
  backEdges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  const backEdgeSet = new Set(backEdges.map(([f, t]) => `${f}>${t}`));
  const reducible = retreating.every(([f, t]) => backEdgeSet.has(`${f}>${t}`));

  const dom: DominatorTree = { idom, children, dominates, preorder, backEdges };
  return { rpo, dom, reducible, unreachable };
}
