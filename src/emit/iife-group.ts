// docs/specs/passes/27-iife-reconstruct.md section 7 -- GROUPING interleaved
// sibling environments so `iife-reconstruct` can wrap them.
//
// `hermesc -O` splices several IIFEs into one caller and then schedules their
// stores freely, so the emitter -- which places each store where the bytecode
// had it -- ends up with environment A's statements sitting between two of
// environment B's. Neither is then a contiguous run and spec 27 refuses both
// with `overlapping statement ranges` (757 environments on
// react-navigation-example-0.85.3 before this step).
//
// This module answers one question and nothing else: may the statements of a
// group of mutually overlapping environments be REORDERED into one block per
// environment? The reordering is the stable partition of the region by owning
// environment, blocks in order of first appearance, so it is a permutation
// built from swaps of statements that belong to different blocks. It is
// allowed only when every such swap is between two statements that provably
// commute:
//
//   * both are inert or a simple `x = <ident|literal>` / `let x` / `let x = ...`
//     store -- no call, no member access (a getter is a side effect), no
//     `new`/`delete`/`throw`, no operator that could reach `valueOf`, and
//   * their read/write footprints are disjoint (no W-W, W-R or R-W pair).
//
// Anything else refuses, and a refusal leaves the statement list exactly as it
// was, so it is never a behaviour change. Conservative by construction: we
// never try to prove that a call is pure.
import type { Expr, Stmt } from "./ast.ts";

/** One environment of an overlapping group, with the range it occupies. */
export interface GroupMember {
  readonly env: number;
  /** Its slot names plus the hoisted children that would move with it. */
  readonly names: ReadonlySet<string>;
  readonly from: number;
  readonly to: number;
}

/** A proved reordering of `body[lo..hi]`. */
export interface GroupPlan {
  readonly lo: number;
  readonly hi: number;
  /** Original indices of `body[lo..hi]`, in their new order. */
  readonly order: readonly number[];
  /** Member environments, in the order their blocks end up in. */
  readonly envs: readonly number[];
}

export type GroupOutcome = { readonly plan: GroupPlan } | { readonly reason: string };

/** Regions bigger than this are refused rather than pair-checked (the swap
 *  check is quadratic and a region this long is never one inlined IIFE). */
const MAX_REGION = 400;

interface Footprint {
  readonly reads: ReadonlySet<string>;
  readonly writes: ReadonlySet<string>;
}

/**
 * An expression with no observable effect and no way to reach user code:
 * identifiers, literals, and array/object literals built only from those. A
 * member access can fire a getter or throw, a call can do anything, a spread
 * runs an iterator or the source's getters, a computed key can hit
 * `Symbol.toPrimitive` -- all of those refuse.
 */
function pureValue(e: Expr, reads: Set<string>): boolean {
  switch (e.k) {
    case "lit":
      return true;
    case "ident":
      reads.add(e.name);
      return true;
    case "array":
      return e.elements.every((el) => pureValue(el, reads));
    case "object":
      return e.props.every((prop) => ("k" in prop ? false : !prop.computed && pureValue(prop.value, reads)));
    default:
      return false;
  }
}

/**
 * The names a statement reads and writes, or null when it may have any effect
 * beyond that (a call, a property access, a control-flow statement, a nested
 * function, anything unclassified). Deliberately tiny: the store-shaped
 * statements that make up an inlined IIFE's tail are the only ones we move.
 */
export function pureFootprint(s: Stmt): Footprint | null {
  const reads = new Set<string>();
  const writes = new Set<string>();
  switch (s.k) {
    case "comment":
      return { reads, writes };
    case "decl":
      for (const n of s.names) writes.add(n);
      return { reads, writes };
    case "init":
      if (!pureValue(s.value, reads)) return null;
      writes.add(s.name);
      return { reads, writes };
    case "expr": {
      const e = s.expr;
      if (e.k !== "assign" || e.target.k !== "ident") return null;
      if (!pureValue(e.value, reads)) return null;
      writes.add(e.target.name);
      return { reads, writes };
    }
    default:
      return null;
  }
}

/** May `a` and `b` be swapped without changing what the function does? */
export function commutes(a: Stmt, b: Stmt): boolean {
  const fa = pureFootprint(a);
  if (fa === null) return false;
  const fb = pureFootprint(b);
  if (fb === null) return false;
  for (const w of fa.writes) if (fb.reads.has(w) || fb.writes.has(w)) return false;
  for (const w of fb.writes) if (fa.reads.has(w)) return false;
  return true;
}

/** Short, identifier-free description of a statement, for refusal counts. */
export function stmtShape(s: Stmt): string {
  if (s.k === "expr") {
    const e = s.expr;
    return e.k === "assign" ? `assign:${e.target.k}=${e.value.k}` : `expr:${e.k}`;
  }
  if (s.k === "init") return `init:${s.value.k}`;
  return s.k;
}

/**
 * Plans the regrouping of one connected group of overlapping environments.
 *
 * `mentions(i, names)` reports whether body statement `i` names any of
 * `names` -- the caller owns that walk (`src/emit/iife-reconstruct.ts`).
 */
export function planGrouping(body: readonly Stmt[], members: readonly GroupMember[], mentions: (index: number, names: ReadonlySet<string>) => boolean): GroupOutcome {
  if (members.length < 2) return { reason: "not a group" };
  let lo = members[0]!.from;
  let hi = members[0]!.to;
  for (const m of members) {
    lo = Math.min(lo, m.from);
    hi = Math.max(hi, m.to);
  }
  if (hi - lo + 1 > MAX_REGION) return { reason: "region too large" };

  // Owner of every statement in the region: the one environment it names, or
  // the previous statement's owner for the filler between two of them (which
  // is what the flat emitter already puts inside an accepted range).
  const owner: number[] = [];
  let cur = -1;
  for (let i = lo; i <= hi; i++) {
    let hit = -1;
    for (let m = 0; m < members.length; m++) {
      if (!mentions(i, members[m]!.names)) continue;
      if (hit >= 0) return { reason: "statement in two environments" };
      hit = m;
    }
    if (hit >= 0) cur = hit;
    if (cur < 0) return { reason: "region does not open on an owned statement" };
    owner.push(cur);
  }

  // Blocks in order of first appearance, statements stable inside a block.
  const seen: number[] = [];
  for (const m of owner) if (!seen.includes(m)) seen.push(m);
  if (seen.length < 2) return { reason: "one owner covers the region" };
  const rank = new Map(seen.map((m, i) => [m, i] as const));
  const order: number[] = [];
  for (const m of seen) {
    for (let i = lo; i <= hi; i++) if (owner[i - lo] === m) order.push(i);
  }

  // Every pair the partition swaps must commute.
  for (let i = lo; i <= hi; i++) {
    const oi = owner[i - lo]!;
    for (let j = i + 1; j <= hi; j++) {
      const oj = owner[j - lo]!;
      if (oi === oj) continue;
      if (rank.get(oj)! > rank.get(oi)!) continue; // stays in order
      if (!commutes(body[i]!, body[j]!)) return { reason: `swap ${stmtShape(body[i]!)} / ${stmtShape(body[j]!)}` };
    }
  }
  return { plan: { lo, hi, order, envs: seen.map((m) => members[m]!.env) } };
}

/** Applies proved plans (disjoint regions) to a statement list. */
export function applyPlans(body: readonly Stmt[], plans: readonly GroupPlan[]): Stmt[] {
  const out = [...body];
  for (const p of plans) {
    for (let k = 0; k < p.order.length; k++) out[p.lo + k] = body[p.order[k]!]!;
  }
  return out;
}

/**
 * Indirection so tooling can observe every grouping decision on a whole
 * bundle without a diagnostic channel (`tools/passes/iife-overlap.ts`), the
 * same shape `tools/passes/ctor-this-refusals.ts` uses for `ctorThis.match`.
 */
export const grouping = { plan: planGrouping };
