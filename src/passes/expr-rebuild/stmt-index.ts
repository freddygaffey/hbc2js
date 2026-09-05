// expr-rebuild's per-statement interest facts and the per-list position index
// built from them -- docs/BUGS.md's "452 s / 946 s" superlinear-pass row,
// part 6, and docs/reports/2026-09-05-perf6-index.md.
//
// `match.ts` asks two questions over and over while classifying a fold site:
//
//   nextRelevant(list, reg, from)      the first index >= from whose statement
//                                      can change a scan's verdict for `reg`
//   anyPassThroughBetween(list, a, b)  is there a fall-through compound
//                                      statement in [a, b)?
//
// Both used to be answered by a direct scan over the already per-node-memoised
// `stmtInterest` (perf part 1). That is `O(distance to the answer)`, which is
// cheap when the answer is near -- and on a module-root function it is not:
// `fn#0` of the Service NSW bundle has ~4,510 fold sites in one statement
// list, and most of its registers are stored once, read once and never
// mentioned again, so "the next statement that mentions `reg`" is usually
// "there is none" and every scan runs to the end of the list. The 2026-09-05
// whole-file profile of that bundle spends ~275 s of 546 s CPU inside
// `nextRelevant` and `stmtInterest` for exactly that reason.
//
// The index answers both in `O(log occurrences)` instead. What makes it worth
// having this time (an eager per-list index was tried and removed in part 1)
// is that it is *derived across a splice* rather than rebuilt: `check.ts` has
// already proven, position by position, that the accepted `after` is `before`
// with one bounded window replaced, so `noteStmtIndexSplice` moves the index
// onto `after` by dropping the window's entries, shifting the tail's by the
// constant length delta and scanning only the newly inserted window. That is
// one integer add per surviving entry -- no `stmtInterest` lookup, no
// allocation -- against the `O(sites x list.length)` WeakMap-and-Set walk it
// replaces. It does not remove the `Theta(sites x list.length)` floor
// docs/PUSHBACK.md P-33/P-34 named (the writer still materialises one
// `readonly Stmt[]` per applied site, which is the same order of work); it
// removes this layer's much larger constant on top of it.
import type { Stmt } from "../ast.ts";
import { registerUses } from "../ast.ts";

export interface StmtInterest {
  /** Register names occurring anywhere in the statement's own frame. */
  readonly regs: ReadonlySet<string>;
  /** A `break`/`continue` occurs anywhere in the statement's own frame. */
  readonly jump: boolean;
  /** `branchVerdict` on this statement hands its enclosing list's
   *  continuation to a sub-list that can fall through into it -- so, with no
   *  mention of `reg` and no jump, its verdict *is* the rest of the list's.
   *  `if`/`labeled`/`iife`/`try` (its handler) always; `switch` with at
   *  least one case. Loops hand `CLEAR` to their body, never `rest`. */
  readonly passThrough: boolean;
}

const stmtInterestMemo = new WeakMap<Stmt, StmtInterest>();

function containsJump(list: readonly Stmt[]): boolean {
  for (const s of list) {
    switch (s.k) {
      case "break":
      case "continue":
        return true;
      case "if":
        if (containsJump(s.then) || containsJump(s.else)) return true;
        break;
      case "while":
      case "do-while":
      case "for":
      case "for-in":
      case "for-of":
      case "labeled":
      case "iife":
        if (containsJump(s.body)) return true;
        break;
      case "try":
        if (containsJump(s.block) || containsJump(s.handler)) return true;
        break;
      case "switch":
        for (const c of s.cases) if (containsJump(c.body)) return true;
        break;
      default:
        break; // expr, init, decl, return, throw, func (a separate frame), directive, comment, raw
    }
  }
  return false;
}

/** Memoised on the statement's own identity (module-level, so it survives
 *  every splice: an untouched statement keeps its object identity through a
 *  rewrite, P-1). */
export function stmtInterest(s: Stmt): StmtInterest {
  let it = stmtInterestMemo.get(s);
  if (it !== undefined) return it;
  const regs = new Set(registerUses([s]).keys());
  const jump = containsJump([s]);
  const passThrough = s.k === "if" || s.k === "labeled" || s.k === "iife" || s.k === "try" || (s.k === "switch" && s.cases.length > 0);
  it = { regs, jump, passThrough };
  stmtInterestMemo.set(s, it);
  return it;
}

/** Sorted-ascending position lists, one per register name plus one each for
 *  the two register-independent facts. Every array is owned by exactly one
 *  list identity (see `noteStmtIndexSplice`) and mutated in place. */
interface StmtIndex {
  readonly byReg: Map<string, number[]>;
  readonly jumps: number[];
  readonly passThroughs: number[];
}

const indexMemo = new WeakMap<readonly Stmt[], StmtIndex>();

/**
 * Below this length a direct scan is cheaper than the index it would have to
 * build: a build is `O(list.length)` `stmtInterest` lookups plus one array
 * per distinct register, while a scan stops at its answer, which in a short
 * list is a handful of statements away. The threshold is a cost floor, not a
 * correctness boundary -- `nextRelevant`/`anyPassThroughBetween` answer
 * identically either way (`tests/gate/passes/stmt-index.test.ts` proves that
 * differentially, on both sides of it).
 */
const INDEX_MIN_LENGTH = 128;

function buildIndex(list: readonly Stmt[]): StmtIndex {
  const byReg = new Map<string, number[]>();
  const jumps: number[] = [];
  const passThroughs: number[] = [];
  for (let k = 0; k < list.length; k++) {
    const it = stmtInterest(list[k]!);
    if (it.jump) jumps.push(k);
    if (it.passThrough) passThroughs.push(k);
    for (const r of it.regs) {
      let a = byReg.get(r);
      if (a === undefined) byReg.set(r, (a = []));
      a.push(k);
    }
  }
  return { byReg, jumps, passThroughs };
}

function indexFor(list: readonly Stmt[]): StmtIndex | null {
  const have = indexMemo.get(list);
  if (have !== undefined) return have;
  if (list.length < INDEX_MIN_LENGTH) return null;
  const built = buildIndex(list);
  indexMemo.set(list, built);
  return built;
}

/** First position in the sorted `arr` at or after `from`, or `arr.length`. */
function lowerBound(arr: readonly number[], from: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function firstAtOrAfter(arr: readonly number[], from: number, none: number): number {
  const p = lowerBound(arr, from);
  return p < arr.length ? arr[p]! : none;
}

/**
 * The smallest index `>= from` whose statement can change a scan's verdict
 * for `reg` (mentions it in its own frame, or contains a jump) --
 * `list.length` when there is none. Every statement skipped over is
 * `clear`-and-keep-going for `reg` (see `match.ts`'s section comment).
 */
export function nextRelevant(list: readonly Stmt[], reg: string, from: number): number {
  const n = list.length;
  if (from >= n) return n;
  if (from < 0) from = 0;
  const idx = indexFor(list);
  if (idx === null) {
    for (let m = from; m < n; m++) {
      const it = stmtInterest(list[m]!);
      if (it.jump || it.regs.has(reg)) return m;
    }
    return n;
  }
  const byReg = idx.byReg.get(reg);
  const a = byReg === undefined ? n : firstAtOrAfter(byReg, from, n);
  if (idx.jumps.length === 0) return a;
  const b = firstAtOrAfter(idx.jumps, from, n);
  return a < b ? a : b;
}

/** Is there a pass-through statement (`if`/`labeled`/`iife`/`try`/non-empty
 *  `switch` -- `stmtInterest`'s `passThrough`) anywhere in `list[from, to)`?
 *  `classifySite` asks only whether there is one, never how many. */
export function anyPassThroughBetween(list: readonly Stmt[], from: number, to: number): boolean {
  const lo = from < 0 ? 0 : from;
  const hi = to > list.length ? list.length : to; // callers pass an in-range `to`; clamped so both paths agree at the edges
  if (lo >= hi) return false;
  const idx = indexFor(list);
  if (idx === null) {
    for (let m = lo; m < hi; m++) if (stmtInterest(list[m]!).passThrough) return true;
    return false;
  }
  return firstAtOrAfter(idx.passThroughs, lo, hi) < hi;
}

/** In-place `arr.splice(p, q - p, ...inserted)` where every surviving entry
 *  from `q` on also moves by `delta`. `arr` stays sorted ascending: the
 *  inserted positions all lie in `[lo, lo + inserted.length)`-ish window the
 *  caller took from `after`, which is below every shifted tail entry. */
function spliceSorted(arr: number[], lo: number, hi: number, delta: number, inserted: readonly number[]): void {
  const p = lowerBound(arr, lo);
  const q = lowerBound(arr, hi);
  const growth = inserted.length - (q - p);
  const oldLen = arr.length;
  if (growth > 0) {
    arr.length = oldLen + growth;
    for (let k = oldLen - 1; k >= q; k--) arr[k + growth] = arr[k]! + delta;
  } else {
    // `growth <= 0`: `k + growth <= k`, so a forward pass never overwrites an
    // entry it has yet to read; at `growth === 0` it rewrites in place, which
    // is exactly where the `delta` shift alone is needed.
    for (let k = q; k < oldLen; k++) arr[k + growth] = arr[k]! + delta;
    if (growth < 0) arr.length = oldLen + growth;
  }
  for (let k = 0; k < inserted.length; k++) arr[p + k] = inserted[k]!;
}

/**
 * Carry `before`'s index onto `after`, given that `after` is `before` with
 * the window `[at, hiBefore)` replaced by `after`'s own `[at, hiAfter)` and
 * every other position unchanged (which `expr-rebuild/check.ts`'s
 * `verifyExpectedShape` has proven position by position before this is
 * called -- it is the same premise `noteRegisterUsesSplice` in `../ast.ts`
 * relies on).
 *
 * The index *moves*: `before` loses it, so nothing can observe a stale one,
 * and a later query on `before` (only the driver's whole-pass revert path
 * does that) rebuilds from scratch. Cost is one pass over the surviving
 * entries after `at` -- integer adds, no `stmtInterest` lookup, no allocation
 * beyond the inserted window's own few entries.
 */
export function noteStmtIndexSplice(before: readonly Stmt[], after: readonly Stmt[], at: number, hiBefore: number, hiAfter: number): void {
  const idx = indexMemo.get(before);
  if (idx === undefined) return; // never built one; `after` will build its own if it is asked
  indexMemo.delete(before);
  const delta = hiAfter - hiBefore;
  const insJumps: number[] = [];
  const insPassThroughs: number[] = [];
  const insByReg = new Map<string, number[]>();
  for (let k = at; k < hiAfter; k++) {
    const it = stmtInterest(after[k]!);
    if (it.jump) insJumps.push(k);
    if (it.passThrough) insPassThroughs.push(k);
    for (const r of it.regs) {
      let a = insByReg.get(r);
      if (a === undefined) insByReg.set(r, (a = []));
      a.push(k);
    }
  }
  const NONE: readonly number[] = [];
  spliceSorted(idx.jumps, at, hiBefore, delta, insJumps);
  spliceSorted(idx.passThroughs, at, hiBefore, delta, insPassThroughs);
  for (const [reg, arr] of idx.byReg) {
    spliceSorted(arr, at, hiBefore, delta, insByReg.get(reg) ?? NONE);
    insByReg.delete(reg);
  }
  for (const [reg, ins] of insByReg) idx.byReg.set(reg, ins.slice());
  indexMemo.set(after, idx);
}

/** Test-only: the positions the index holds for one register (or `null` when
 *  this list is below `INDEX_MIN_LENGTH` and has none). Used by
 *  `tests/gate/passes/stmt-index.test.ts` to compare the index against a
 *  brute-force scan after a chain of splices. */
export function stmtIndexPositions(list: readonly Stmt[], reg: string): readonly number[] | null {
  const idx = indexFor(list);
  if (idx === null) return null;
  return idx.byReg.get(reg) ?? [];
}
