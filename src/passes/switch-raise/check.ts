// switch-raise checker — spec 10 §6. Class: CF-preserving (ladder §4.3).
//
// Obligation 2 is the rung's real proof and it is re-derived from `before`
// alone (never from `m.data`): for every case value and for the default, the
// sequence of CFG blocks the arm's path visits in `after` (its body, plus
// every arm it falls through into, until an abrupt statement or the switch's
// exit) must equal the same walk over `before`'s nest (its body, then the
// tail its trailing `break Lk` lands in). The driver then re-runs the
// whole-function `reconstruct` + `checkIsomorphic` round-trip, which — with
// F12's fall-through model in verify.ts — proves the moved tails edge by edge.
import { children } from "../../structure/ir.ts";
import type { LabelId, Stmt, SwitchArm } from "../../structure/ir.ts";
import type { CheckResult } from "../types.ts";
import { blocksMultiset, completesNormally, items, usesOf } from "../tree.ts";
import { postOrder } from "../driver.ts";
import { classifyBody, peel } from "./match.ts";
import type { SwitchNode } from "./match.ts";

export function check(before: Stmt, after: Stmt): CheckResult {
  const peeled = peel(before);
  if (peeled === null) return { ok: false, reason: "before-shape" };
  const { levels, sw } = peeled;

  // §6.5 — exactly one switch node, same cfgBlock, same scrutinee object.
  const switches = postOrder(after).filter((s): s is SwitchNode => s.k === "switch");
  if (switches.length !== 1) return { ok: false, reason: "switch-count" };
  const aSw = switches[0]!;
  if (aSw.cfgBlock !== sw.cfgBlock || aSw.scrutinee !== sw.scrutinee) return { ok: false, reason: "switch-identity" };

  // §6.1 — every block/return/throw/if/switch/try leaf survives exactly once.
  if (!sameMultiset(blocksMultiset(before), blocksMultiset(after))) return { ok: false, reason: "blocks-changed" };

  // §6.3 — peeled labels have zero uses in `after`; all other labels' use
  // multisets are unchanged.
  const peeledIds = new Set(levels.map((l) => l.label));
  for (const l of peeledIds) {
    const u = usesOf(after, l);
    if (u.breaks + u.continues > 0) return { ok: false, reason: "peeled-label-survives" };
  }
  if (!sameMultiset(labelUses(before, peeledIds), labelUses(after, peeledIds))) return { ok: false, reason: "label-uses-changed" };

  // §6.4 — values are a permutation, pairwise distinct, isString preserved.
  const bv = sw.cases.map(armKey).sort();
  const av = aSw.cases.map(armKey).sort();
  if (bv.length !== av.length || bv.some((v, i) => v !== av[i]) || new Set(av).size !== av.length) return { ok: false, reason: "case-values-changed" };

  // §6.6 — no silently unreachable fall-through, and no arm falls into the
  // default (the writer never produces either).
  for (const c of aSw.cases) {
    if (c.fallThrough === true && !completesNormally(c.body)) return { ok: false, reason: "dead-fall-through" };
  }
  if (aSw.cases.length > 0 && aSw.cases[aSw.cases.length - 1]!.fallThrough === true) return { ok: false, reason: "fall-through-into-default" };

  // §6.2 — the per-arm path walk.
  const outer = levels[0]!.label;
  const beforePath = (body: Stmt): number[] | null => {
    const cls = classifyBody(body, levels);
    if (cls === null) return null;
    const its = items(body);
    const trailing = cls.kind !== "free" && cls.trailing;
    const ids = blocksInOrder(trailing ? its.slice(0, -1) : its);
    if (cls.kind === "seg") {
      let s = cls.startSeg;
      while (s >= 0 && levels[s]!.tail.length === 0) s--;
      if (s >= 0) {
        const t = levels[s]!.tail;
        const last = t[t.length - 1]!;
        if (last.k === "break") {
          if (last.label !== outer) return null; // a cascading tail — cannot model the path
          ids.push(...blocksInOrder(t.slice(0, -1)));
        } else {
          if (s > 0 && completesNormally(last)) return null; // cascade
          ids.push(...blocksInOrder(t));
        }
      }
    }
    return ids;
  };
  const byKey = new Map(aSw.cases.map((c, i) => [armKey(c), i]));
  const afterPath = (k: string): number[] => {
    const out: number[] = [];
    for (let i = byKey.get(k)!; i < aSw.cases.length; i++) {
      const c = aSw.cases[i]!;
      const its = items(c.body);
      out.push(...blocksInOrder(its));
      const last = its[its.length - 1];
      if (last !== undefined && !completesNormally(last)) break; // abrupt exit
      if (c.fallThrough !== true) break; // the emitter's appended `break;`
    }
    return out;
  };
  for (const c of sw.cases) {
    const bp = beforePath(c.body);
    if (bp === null) return { ok: false, reason: "path-underivable" };
    if (!sameSeq(bp, afterPath(armKey(c)))) return { ok: false, reason: "path-diverged" };
  }
  const bd = beforePath(sw.default);
  if (bd === null) return { ok: false, reason: "path-underivable" };
  if (!sameSeq(bd, blocksInOrder(items(aSw.default)))) return { ok: false, reason: "default-path-diverged" };

  return { ok: true };
}

const armKey = (c: SwitchArm): string => `${c.isString ? "s" : "n"}${c.value}`;

/** Deterministic in-order block collection: a statement's own cfgBlock first,
 *  then its children in `children()` order. Both sides of the §6.2 comparison
 *  use this same walk, so nested shapes compare like for like. */
function blocksInOrder(stmts: readonly Stmt[]): number[] {
  const out: number[] = [];
  const visit = (s: Stmt): void => {
    if ((s.k === "block" || s.k === "if" || s.k === "return" || s.k === "throw" || s.k === "switch" || s.k === "try") && s.cfgBlock >= 0) out.push(s.cfgBlock);
    for (const c of children(s)) visit(c);
  };
  for (const s of stmts) visit(s);
  return out;
}

function sameSeq(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameMultiset<K>(a: ReadonlyMap<K, number>, b: ReadonlyMap<K, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function labelUses(node: Stmt, exclude: ReadonlySet<LabelId>): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of postOrder(node)) {
    if ((n.k === "break" || n.k === "continue") && !exclude.has(n.label)) {
      const key = `${n.k}:${n.label}`;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
  return out;
}
