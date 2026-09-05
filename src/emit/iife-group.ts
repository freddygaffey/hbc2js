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
//     store -- no call, no `new`/`delete`/`throw`, no operator that could reach
//     `valueOf`, and no member access EXCEPT one whose base spec 27 section 9's
//     escape analysis (`src/emit/iife-escape.ts`) proves is a fresh, unescaped
//     allocation of this function, where no getter, setter or proxy exists to
//     observe the order, and
//   * their read/write footprints are disjoint (no W-W, W-R or R-W pair).
//
// Anything else refuses, and a refusal leaves the statement list exactly as it
// was, so it is never a behaviour change. Conservative by construction: we
// never try to prove that a call is pure.
import type { Expr, Stmt } from "./ast.ts";
import type { EscapeCode, EscapeInfo } from "./iife-escape.ts";
import { analyseEscapes } from "./iife-escape.ts";

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

export type GroupOutcome =
  | { readonly plan: GroupPlan; readonly codes?: ReadonlyMap<string, EscapeCode> }
  | { readonly reason: string; readonly codes?: ReadonlyMap<string, EscapeCode> };

/** Extra statements of the same function that are not in `body` (the
 *  emitter's header): scanned by the escape analysis for captures only. */
export interface GroupOptions {
  readonly outer?: readonly Stmt[];
}

/** Regions bigger than this are refused rather than pair-checked (the swap
 *  check is quadratic and a region this long is never one inlined IIFE). */
const MAX_REGION = 400;

interface Footprint {
  readonly reads: ReadonlySet<string>;
  readonly writes: ReadonlySet<string>;
}

/** Where a statement sits, so a member access can be tested against the
 *  allocation that made its base fresh (spec 27 section 9.1). */
export interface FootprintCtx {
  readonly escapes: EscapeInfo;
  readonly index: number;
}

function freshAt(ctx: FootprintCtx | undefined, base: Expr): boolean {
  if (ctx === undefined || base.k !== "ident") return false;
  const at = ctx.escapes.fresh.get(base.name);
  return at !== undefined && ctx.index > at;
}

/** The pseudo-name a member access writes/reads: section 9.2. Literal keys
 *  only -- proving two register keys distinct is a separate argument. */
function memberSlot(e: Expr, reads: Set<string>): string | null {
  if (e.k !== "member" || e.obj.k !== "ident") return null;
  const key = e.prop.k === "lit" ? e.prop.text : null;
  if (key === null) return null;
  reads.add(e.obj.name);
  return `${e.obj.name}#${key}`;
}

/**
 * An expression with no observable effect and no way to reach user code:
 * identifiers, literals, array/object literals built only from those, and the
 * intrinsic `NewArray` allocation (`fromNewArray`, section 9.1 F1). A member
 * access can fire a getter or throw, a call can do anything, a spread runs an
 * iterator or the source's getters, a computed key can hit
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
    case "new":
      return e.fromNewArray === true && e.args.every((a) => a.k === "lit");
    default:
      return false;
  }
}

/**
 * The names a statement reads and writes, or null when it may have any effect
 * beyond that (a call, an unproven property access, a control-flow statement,
 * a nested function, anything unclassified). Deliberately tiny: the
 * store-shaped statements that make up an inlined IIFE's tail are the only
 * ones we move.
 */
export function pureFootprint(s: Stmt, ctx?: FootprintCtx): Footprint | null {
  const reads = new Set<string>();
  const writes = new Set<string>();
  switch (s.k) {
    case "comment":
      return { reads, writes };
    case "decl":
      for (const n of s.names) writes.add(n);
      return { reads, writes };
    case "init":
      if (!valueInto(s.value, reads, ctx)) return null;
      writes.add(s.name);
      return { reads, writes };
    case "expr": {
      const e = s.expr;
      if (e.k !== "assign") return null;
      if (e.target.k === "member") {
        // Section 9.2: a store into a proven-fresh, unescaped allocation.
        if (!freshAt(ctx, e.target.obj)) return null;
        const slot = memberSlot(e.target, reads);
        if (slot === null) return null;
        if (!pureValue(e.value, reads)) return null;
        writes.add(slot);
        return { reads, writes };
      }
      if (e.target.k !== "ident") return null;
      if (!valueInto(e.value, reads, ctx)) return null;
      writes.add(e.target.name);
      return { reads, writes };
    }
    default:
      return null;
  }
}

/** A value expression: pure, or a load from a proven-fresh base. */
function valueInto(value: Expr, reads: Set<string>, ctx: FootprintCtx | undefined): boolean {
  if (value.k === "member") {
    if (!freshAt(ctx, value.obj)) return false;
    const slot = memberSlot(value, reads);
    if (slot === null) return false;
    reads.add(slot);
    return true;
  }
  return pureValue(value, reads);
}

/** May `a` and `b` be swapped without changing what the function does? */
export function commutes(a: Stmt, b: Stmt, ctxA?: FootprintCtx, ctxB?: FootprintCtx): boolean {
  const fa = pureFootprint(a, ctxA);
  if (fa === null) return false;
  const fb = pureFootprint(b, ctxB);
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
export function planGrouping(body: readonly Stmt[], members: readonly GroupMember[], mentions: (index: number, names: ReadonlySet<string>) => boolean, opts: GroupOptions = {}): GroupOutcome {
  if (members.length < 2) return { reason: "not a group" };
  let lo = members[0]!.from;
  let hi = members[0]!.to;
  for (const m of members) {
    lo = Math.min(lo, m.from);
    hi = Math.max(hi, m.to);
  }
  if (hi - lo + 1 > MAX_REGION) return { reason: "region too large" };

  // Owner of every statement in the region: the one environment it names, or
  // NONE (a "filler" -- `r0 = a2`, the allocation an inlined IIFE fills in).
  const owner: (number | null)[] = [];
  for (let i = lo; i <= hi; i++) {
    let hit: number | null = null;
    for (let m = 0; m < members.length; m++) {
      if (!mentions(i, members[m]!.names)) continue;
      if (hit !== null) return { reason: "statement in two environments" };
      hit = m;
    }
    owner.push(hit);
  }
  if (owner[0] === null) return { reason: "region does not open on an owned statement" };

  // Blocks in order of first appearance of an OWNED statement.
  const seen: number[] = [];
  for (const m of owner) if (m !== null && !seen.includes(m)) seen.push(m);
  if (seen.length < 2) return { reason: "one owner covers the region" };
  const rank = new Map(seen.map((m, i) => [m, i] as const));

  // Section 9: which member bases in the region are provably fresh.
  const escapes = analyseEscapes(body, lo, hi, opts.outer ?? []);
  const codes = escapes.codes;
  const ctx = (i: number): FootprintCtx => ({ escapes, index: i });

  // Section 9.3: a filler starts attached to the preceding block and is moved
  // to the other side of a blocking swap when that is what blocks the group.
  // Soundness does not depend on the repair: the labelling is verified pair by
  // pair below whatever the repair chose.
  const label: number[] = [];
  let cur = owner[0]!;
  for (const m of owner) {
    if (m !== null) cur = m;
    label.push(cur);
  }

  const firstBlocked = (): readonly [number, number] | null => {
    for (let i = lo; i <= hi; i++) {
      for (let j = i + 1; j <= hi; j++) {
        const li = label[i - lo]!;
        const lj = label[j - lo]!;
        if (li === lj) continue;
        if (rank.get(lj)! > rank.get(li)!) continue; // stays in order
        if (!commutes(body[i]!, body[j]!, ctx(i), ctx(j))) return [i, j];
      }
    }
    return null;
  };

  const budget = 2 * (hi - lo + 1);
  for (let round = 0; ; round++) {
    const bad = firstBlocked();
    if (bad === null) break;
    const [i, j] = bad;
    if (round >= budget) return { reason: "regrouping did not converge", codes };
    if (owner[j - lo] === null) label[j - lo] = label[i - lo]!;
    else if (owner[i - lo] === null) label[i - lo] = label[j - lo]!;
    else return { reason: `swap ${stmtShape(body[i]!)} / ${stmtShape(body[j]!)}`, codes };
  }

  const order: number[] = [];
  for (const m of seen) {
    for (let i = lo; i <= hi; i++) if (label[i - lo] === m) order.push(i);
  }
  return { plan: { lo, hi, order, envs: seen.map((m) => members[m]!.env) }, codes };
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
export const grouping: { plan: typeof planGrouping } = { plan: planGrouping };
