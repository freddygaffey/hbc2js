// if-chain checker — spec 09 §6. Class: CF-preserving (ladder §4.3) for C1;
// annotation-only for C3. For C1 the driver's whole-function round-trip is
// the real proof (the reconstructed CFG must be edge-for-edge the staircase's);
// C3 gets nothing from it (`sameShape` holds), so the §6.4 re-derivation from
// `before` — never from `m.data` — is its only guard.
import type { Stmt } from "../../structure/ir.ts";
import type { CheckResult } from "../types.ts";
import { blocksMultiset, completesNormally, items, sameShape } from "../tree.ts";
import { postOrder } from "../driver.ts";
import { chainLink } from "./match.ts";
import type { IfNode } from "./match.ts";

export function check(before: Stmt, after: Stmt): CheckResult {
  if (before.k !== "if") return { ok: false, reason: "before-not-if" };
  return after.k === "if" ? checkC3(before, after as IfNode) : checkC1(before, after);
}

/** §6.1–§6.3, §6.5 — the else-drop obligations, re-derived from `before`. */
function checkC1(before: IfNode, after: Stmt): CheckResult {
  if (completesNormally(before.then)) return { ok: false, reason: "then-falls-through" };
  if (after.k !== "seq" || after.body.length < 2) return { ok: false, reason: "rewrite-shape" };
  const head = after.body[0]!;
  if (head.k !== "if" || head.cfgBlock !== before.cfgBlock || head.then !== before.then || items(head.else).length !== 0) return { ok: false, reason: "rewrite-shape" };
  // §6.1: the statements now following the `if` are exactly `before`'s else
  // items, in order — identity comparison, no re-walk.
  const beforeElse = items(before.else);
  const tail = after.body.slice(1);
  if (tail.length !== beforeElse.length || tail.some((s, i) => s !== beforeElse[i])) return { ok: false, reason: "else-items-reordered" };
  // §6.2: no block/return/throw/if/try/switch leaf added, removed or duplicated.
  if (!sameMultiset(blocksMultiset(before), blocksMultiset(after))) return { ok: false, reason: "blocks-changed" };
  // §6.3: the multiset of (label, kind) jump uses is unchanged.
  if (!sameMultiset(labelUses(before), labelUses(after))) return { ok: false, reason: "label-uses-changed" };
  // §6.5: keep the tree canonical so a second run is a fixed point.
  if (after.body.some((s) => s.k === "seq")) return { ok: false, reason: "nested-seq" };
  for (const n of postOrder(after)) if (n.k === "if" && n.then === n.else) return { ok: false, reason: "aliased-arms" };
  return { ok: true };
}

/** §6.4 — the annotation-only obligations, including the C3 shape predicate. */
function checkC3(before: IfNode, after: IfNode): CheckResult {
  if (before.elseIf === true) return { ok: false, reason: "already-annotated" };
  if (after.elseIf !== true) return { ok: false, reason: "annotation-missing" };
  if (!sameShape(before, after)) return { ok: false, reason: "shape-changed" };
  if (chainLink(items(before.else)) === null) return { ok: false, reason: "not-a-chain-link" };
  return { ok: true };
}

function sameMultiset<K>(a: ReadonlyMap<K, number>, b: ReadonlyMap<K, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function labelUses(node: Stmt): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of postOrder(node)) {
    if (n.k === "break" || n.k === "continue") {
      const key = `${n.k}:${n.label}`;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
  return out;
}
