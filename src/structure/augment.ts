// docs/specs/04-structurer.md §4.5 — turn exception regions into ordinary
// two-way branches before Ramsey runs. See the `AugmentedCfg` doc comment in
// ir.ts for the shape and why.
//
// Where the try-head goes, and why it is not simply the region's first block:
//
//  * A Hermes exception region is a *byte range*, and a compiler-lowered
//    generator body enters one such range at more than one block (measured on
//    `23-generator-basic` v99 function #3: region 2 covers blocks 12..15 and is
//    entered at both 12 and 13, from two arms of the state dispatch).
//  * A region body can also contain the *handler* block of a nested region
//    (a `catch` clause that is itself inside an outer `try` —
//    `24-generator-return-throw` v94 function #4, region 2), which is entered
//    only through an exception edge.
//
// So the try-head is placed immediately above **D**, the dominator-tree LCA of
// the region's entry blocks, computed on the graph *as augmented so far*.
// That guarantees the property the structurer needs — every block of the region
// is dominated by D, hence emitted inside the try (P6, no under-reach) — at the
// cost of the try sometimes covering blocks outside the region. That over-reach
// is made harmless by the emitter's `__pc` guard: the catch clause rethrows
// unless the block that actually threw was inside the region's own range.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { BlockId, Edge, FunctionCfg } from "../cfg/types.ts";
import { edgeKey } from "./ir.ts";
import type { AugBlock, AugmentedCfg, AugTerminator } from "./ir.ts";

interface DomInfo {
  readonly preds: readonly (readonly BlockId[])[];
  readonly inDegree: Int32Array;
  readonly rpo: readonly BlockId[];
  readonly rpoIndex: readonly number[];
  readonly idom: readonly (BlockId | null)[];
  readonly domChildren: readonly (readonly BlockId[])[];
  dominates(a: BlockId, b: BlockId): boolean;
  readonly retreating: readonly (readonly [BlockId, BlockId])[];
}

function domInfo(blocks: readonly AugBlock[], entry: BlockId, functionIndex: number): DomInfo {
  const n = blocks.length;
  const preds: BlockId[][] = blocks.map(() => []);
  const inDegree = new Int32Array(n);
  const predSet: Set<BlockId>[] = blocks.map(() => new Set<BlockId>());
  for (const b of blocks) {
    for (const e of b.succs) {
      inDegree[e.to]!++;
      if (predSet[e.to]!.has(e.from)) continue;
      predSet[e.to]!.add(e.from);
      preds[e.to]!.push(e.from);
    }
  }
  for (const p of preds) p.sort((a, z) => a - z);

  const state = new Uint8Array(n);
  const nextEdge = new Int32Array(n);
  const post: BlockId[] = [];
  const retreating: [BlockId, BlockId][] = [];
  const stack: BlockId[] = [entry];
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
      } else if (state[t] === 1) retreating.push([b, t]);
      continue;
    }
    state[b] = 2;
    post.push(b);
    stack.pop();
  }
  const rpo = [...post].reverse();
  const rpoIndex = new Array<number>(n).fill(-1);
  for (const [i, b] of rpo.entries()) rpoIndex[b] = i;

  const idomIdx = new Int32Array(rpo.length).fill(-1);
  if (rpo.length > 0) idomIdx[0] = 0;
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
  let guard = 0;
  while (changed) {
    changed = false;
    if (++guard > rpo.length + 2) throw new Hbc2jsError(ErrorCode.E_INTERNAL, `augmented dominator iteration did not converge`, { functionIndex, section: "structure/augment" });
    for (let i = 1; i < rpo.length; i++) {
      const b = rpo[i]!;
      let nd = -1;
      for (const p of preds[b]!) {
        const pi = rpoIndex[p]!;
        if (pi === -1 || idomIdx[pi] === -1) continue;
        nd = nd === -1 ? pi : intersect(pi, nd);
      }
      if (nd !== -1 && idomIdx[i] !== nd) {
        idomIdx[i] = nd;
        changed = true;
      }
    }
  }

  const idom: (BlockId | null)[] = new Array<BlockId | null>(n).fill(null);
  const domChildren: BlockId[][] = blocks.map(() => []);
  for (let i = 1; i < rpo.length; i++) {
    const b = rpo[i]!;
    const dd = idomIdx[i]!;
    if (dd === -1) continue;
    const parent = rpo[dd]!;
    idom[b] = parent;
    domChildren[parent]!.push(b);
  }
  // §4.3 determinism, and §4.2's ordering constraint: dominator children in
  // descending RPO index, so a merge point later in RPO stays breakable-to from
  // inside the handling of an earlier one.
  for (const c of domChildren) c.sort((a, z) => rpoIndex[z]! - rpoIndex[a]! || z - a);

  const tin = new Int32Array(n).fill(-1);
  const tout = new Int32Array(n).fill(-1);
  let clock = 0;
  const walk: { node: BlockId; i: number }[] = [{ node: entry, i: 0 }];
  tin[entry] = clock++;
  while (walk.length > 0) {
    const top = walk[walk.length - 1]!;
    const kids = domChildren[top.node]!;
    if (top.i < kids.length) {
      const c = kids[top.i++]!;
      tin[c] = clock++;
      walk.push({ node: c, i: 0 });
      continue;
    }
    tout[top.node] = clock++;
    walk.pop();
  }
  const dominates = (a: BlockId, b: BlockId): boolean => tin[a] !== -1 && tin[b] !== -1 && tin[a]! <= tin[b]! && tout[b]! <= tout[a]!;

  return { preds, inDegree, rpo, rpoIndex, idom, domChildren, dominates, retreating };
}

function lca(info: DomInfo, a: BlockId, b: BlockId, fallback: BlockId): BlockId {
  const depth = (x: BlockId): number => {
    let d = 0;
    let cur: BlockId | null = x;
    let guard = 0;
    while (cur !== null && guard++ < 1_000_000) {
      cur = info.idom[cur] ?? null;
      d++;
    }
    return d;
  };
  if (info.rpoIndex[a] === -1 || info.rpoIndex[b] === -1) return fallback;
  let x = a;
  let y = b;
  let dx = depth(x);
  let dy = depth(y);
  while (dx > dy) {
    const p = info.idom[x];
    if (p === undefined || p === null) return fallback;
    x = p;
    dx--;
  }
  while (dy > dx) {
    const p = info.idom[y];
    if (p === undefined || p === null) return fallback;
    y = p;
    dy--;
  }
  while (x !== y) {
    const px = info.idom[x];
    const py = info.idom[y];
    if (px === undefined || px === null || py === undefined || py === null) return fallback;
    x = px;
    y = py;
  }
  return x;
}

export function augment(cfg: FunctionCfg): AugmentedCfg {
  const blocks: AugBlock[] = cfg.blocks.map((b) => ({ id: b.id, block: b, terminator: b.terminator as AugTerminator, succs: [...b.succs] }));
  const tryHeads = new Map<BlockId, number>();
  let entry = cfg.entry;
  let info = domInfo(blocks, entry, cfg.functionIndex);

  // Outermost-first (cfg.regions is already sorted that way).
  for (const region of cfg.regions) {
    const entries: BlockId[] = [];
    for (const b of region.bodyBlocks) {
      if (info.rpoIndex[b] === -1) continue; // not reachable yet
      if (b === entry || info.preds[b]!.some((p) => !region.bodyBlocks.has(p))) entries.push(b);
    }
    if (entries.length === 0) continue; // unreachable region body

    let d = entries[0]!;
    for (const e of entries.slice(1)) d = lca(info, d, e, entry);

    const id = blocks.length;
    const succs: Edge[] = [
      { from: id, to: d, kind: "branch-taken" },
      { from: id, to: region.handlerBlock, kind: "branch-not-taken" },
    ];
    blocks.push({ id, block: null, terminator: { kind: "try", region: region.index }, succs });
    tryHeads.set(id, region.index);

    // Every edge entering D's dominator subtree from outside now enters the
    // try-head instead. Back edges from inside the subtree keep their target, so
    // a loop inside the try stays a loop rather than re-entering the try.
    for (const b of blocks) {
      if (b.id === id) continue;
      if (b.id !== d && info.dominates(d, b.id)) continue;
      (b as { succs: readonly Edge[] }).succs = b.succs.map((e) => (e.to === d ? { ...e, to: id } : e));
    }
    if (entry === d) entry = id;
    info = domInfo(blocks, entry, cfg.functionIndex);
  }

  const backEdges = new Set<string>();
  const loopHeaders = new Set<BlockId>();
  for (const b of blocks) {
    for (const e of b.succs) {
      if (!info.dominates(e.to, e.from)) continue;
      backEdges.add(edgeKey(e.from, e.to));
      loopHeaders.add(e.to);
    }
  }

  // A merge point is measured by *edge* in-degree, not deduplicated predecessor
  // count: spec 03 §4.5's resume dispatcher sends both `case 0` and `default` to
  // the real entry block, and a jump table routinely sends several cases to one
  // target. Counting predecessors instead would inline such a block once per
  // edge, which P3 catches as an undeclared duplication.
  const mergePoints = new Set<BlockId>();
  for (const b of blocks) {
    if (info.rpoIndex[b.id] === -1) continue;
    if (loopHeaders.has(b.id)) continue;
    if (info.inDegree[b.id]! >= 2) mergePoints.add(b.id);
  }

  const reducible = info.retreating.every(([f, t]) => backEdges.has(edgeKey(f, t)));

  return {
    cfg,
    blocks,
    entry,
    preds: info.preds,
    rpo: info.rpo,
    rpoIndex: info.rpoIndex,
    idom: info.idom,
    domChildren: info.domChildren,
    dominates: info.dominates,
    backEdges,
    loopHeaders,
    mergePoints,
    tryHeads,
    reducible,
  };
}
