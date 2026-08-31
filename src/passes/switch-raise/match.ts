// switch-raise matcher — docs/specs/passes/10-switch-raise.md §4, catalogue
// rows 6 and 7 (docs/lowering/switch.md; both ✅ verified at ≥3 versions —
// `src/disasm` normalises the v99 `SwitchImm`→`UIntSwitchImm` rename away, so
// `versions` is unset).
//
// S1 (jump-table fall-through raise): the structurer wraps a jump-table
// `switch` node in a nest of `labeled` blocks and encodes source fall-through
// as `break Lk` into the labels' tails. This matcher recognises the whole
// nest at its *outermost* `labeled` (an inner level refuses naturally: its
// arms' `break`s target labels that are not peeled at that depth — A5), and
// plans a flat arm list in which every tail lives inside the switch and
// fall-through is the `SwitchArm.fallThrough` annotation (F12).
//
// S2 (compare-chain raise, row 6 on its own) is **blocked on F13** (a
// `{t:"compare"}` `Scrutinee` variant plus its verify.ts P5 rule — a spec-04
// change reviewed with the structurer's owner). Per spec §4, until F13 lands
// S2's match returns null unconditionally, which here means: no S2 code
// exists, and fixtures 09/10 (compare chains at every corpus version) stay
// red. `if-chain`'s `switch-arm-spine` refusal stays unimplemented for the
// same reason — it keys on S2's chain predicate (spec 09 §7).
//
// Refusals (spec §7) are match-time `null`s, reasons documented inline:
// nest-not-linear (A1), no-switch-core (A2), not-jumptable (A3),
// already-raised (A4), label-escapes / continue-to-switch-label (A5),
// duplicate-case-value (A6), unclassifiable-arm, two-bodied-arms-in-group
// (B1), cascading-tail-with-arms (B2 — this implementation takes the spec's
// "minimum viable subset" and refuses every cascade), segment-nonlocal-break
// (B3 — a segment may end only in `break L_0`/`return`/`throw`/`continue`-to-
// outside), default-must-not-fall-through (B4), plus the conservative extras
// buried-break (a peeled-label `break` that is not a trailing statement) and
// unreachable-tail (a non-empty tail no arm runs), and the whole-function
// refusals generator-dispatcher and switch-in-try.
import type { LabelId, Stmt, SwitchArm } from "../../structure/ir.ts";
import type { Match, PassContext } from "../types.ts";
import { completesNormally, items, usesOf } from "../tree.ts";
import { postOrder } from "../driver.ts";

export type SwitchNode = Stmt & { readonly k: "switch" };
export type LabeledNode = Stmt & { readonly k: "labeled" };

/** One peeled `labeled` level: its label and the statements after the nested
 *  level (or after the core, for the innermost) — the spec's `T_i`. */
export interface Level {
  readonly label: LabelId;
  readonly tail: readonly Stmt[];
}

export interface Peeled {
  /** Outermost first; `levels[levels.length - 1]` is the innermost. */
  readonly levels: readonly Level[];
  /** `[block bX, switch bX]` or `[switch]` — spliced back verbatim minus the switch. */
  readonly core: readonly Stmt[];
  readonly sw: SwitchNode;
}

/** One arm of the planned raised switch, in emission order. */
export interface PlannedArm {
  readonly value: number;
  readonly isString: boolean;
  readonly fallThrough: boolean;
  readonly body: readonly Stmt[];
}

export interface RaiseSite {
  readonly rule: "S1";
  readonly peeled: Peeled;
  readonly newCases: readonly PlannedArm[];
  readonly newDefault: readonly Stmt[];
}

export type RaiseMatch = Match<Stmt, RaiseSite>;

/** §4 peel: descend while the first item is the next `labeled`; the innermost
 *  level's body must then start with the switch core (A1/A2). Shared with the
 *  checker, which re-derives everything from `before`. */
export function peel(node: Stmt): Peeled | null {
  if (node.k !== "labeled") return null;
  const levels: Level[] = [];
  let cur: LabeledNode = node;
  for (;;) {
    const its = items(cur.body);
    const first = its[0];
    if (first === undefined) return null; // nest-not-linear (A1)
    if (first.k === "labeled") {
      levels.push({ label: cur.label, tail: its.slice(1) });
      cur = first;
      continue;
    }
    if (first.k === "switch") {
      levels.push({ label: cur.label, tail: its.slice(1) });
      return { levels, core: [first], sw: first };
    }
    if (first.k === "block" && its[1]?.k === "switch" && its[1].cfgBlock === first.cfgBlock) {
      // The cfgBlock equality is required: block and switch are the same CFG
      // block, split by lowerTree into instructions and terminator (A2).
      levels.push({ label: cur.label, tail: its.slice(2) });
      return { levels, core: [first, its[1]], sw: its[1] as SwitchNode };
    }
    return null; // no-switch-core (A2)
  }
}

/**
 * §4's arm classification by the body's *last* statement.
 * `seg` means "runs `tails[startSeg]` next, then exits"; `exit` means "leaves
 * the switch directly" (a trailing `break L_0`); `free` means the arm never
 * reaches a tail (`return`/`throw`/`continue` to a label outside the nest).
 * `trailing` records whether the last statement is a deleted peeled break.
 */
export type ArmClass = { readonly kind: "seg"; readonly startSeg: number; readonly trailing: boolean } | { readonly kind: "exit"; readonly trailing: boolean } | { readonly kind: "free" };

export function classifyBody(body: Stmt, levels: readonly Level[]): ArmClass | null {
  const its = items(body);
  const last = its[its.length - 1];
  const n = levels.length - 1;
  if (last === undefined) return { kind: "seg", startSeg: n, trailing: false }; // empty body falls out of the switch
  if (last.k === "break") {
    const idx = levels.findIndex((l) => l.label === last.label);
    if (idx === -1) return null; // break to a non-peeled label — unclassifiable-arm (A5 refuses it globally too)
    return idx === 0 ? { kind: "exit", trailing: true } : { kind: "seg", startSeg: idx - 1, trailing: true };
  }
  if (last.k === "return" || last.k === "throw") return { kind: "free" };
  if (last.k === "continue") return levels.some((l) => l.label === last.label) ? null : { kind: "free" }; // continue-to-switch-label
  if (completesNormally(last)) return { kind: "seg", startSeg: n, trailing: false };
  return null; // unclassifiable-arm (e.g. `unreachable`, or an `if` whose arms are both abrupt)
}

const armKey = (c: SwitchArm): string => `${c.isString ? "s" : "n"}${c.value}`;

/** Total `break`s to any peeled label under `s` (buried-break discipline). */
function peeledBreaks(s: Stmt, levels: readonly Level[]): number {
  return levels.reduce((acc, l) => acc + usesOf(s, l.label).breaks, 0);
}

/**
 * §4/§5 planning: classify every arm, validate the linearisation constraints
 * (minimum viable subset — every cascade refused), and lay the arms out with
 * each tail appended to the last arm of the group that runs it. Returns null
 * on any refusal. Shared shape logic with the checker via `peel`/`classifyBody`.
 */
export function plan(peeled: Peeled): { readonly newCases: readonly PlannedArm[]; readonly newDefault: readonly Stmt[] } | null {
  const { levels, sw } = peeled;
  const n = levels.length - 1;
  if (sw.scrutinee.t !== "jumptable") return null; // not-jumptable (A3)
  if (sw.cases.some((c) => c.fallThrough !== undefined)) return null; // already-raised (A4)
  if (new Set(sw.cases.map(armKey)).size !== sw.cases.length) return null; // duplicate-case-value (A6)

  const classes: ArmClass[] = [];
  for (const c of sw.cases) {
    const cls = classifyBody(c.body, levels);
    if (cls === null) return null; // unclassifiable-arm
    classes.push(cls);
  }
  const dflt = classifyBody(sw.default, levels);
  if (dflt === null || dflt.kind === "seg") return null; // default-must-not-fall-through (B4)

  // Buried-break discipline: a peeled-label break may appear only as the
  // trailing statement classification saw (arm bodies and default).
  const disciplined = (body: Stmt, cls: ArmClass): boolean => peeledBreaks(body, levels) === (cls.kind !== "free" && cls.trailing ? 1 : 0);
  if (!sw.cases.every((c, i) => disciplined(c.body, classes[i]!))) return null; // buried-break
  if (!disciplined(sw.default, dflt)) return null; // buried-break

  // Tails: each non-empty tail must end abruptly without cascading (B2/B3,
  // minimum subset), and its own peeled breaks are the trailing one only.
  const outer = levels[0]!.label;
  for (let s = 0; s <= n; s++) {
    const t = levels[s]!.tail;
    const last = t[t.length - 1];
    if (last === undefined) continue;
    const tailBreaks = t.reduce((acc, st) => acc + peeledBreaks(st, levels), 0);
    if (last.k === "break") {
      if (last.label !== outer) return null; // segment-nonlocal-break (B3): only `break L_0` may end a tail
      if (tailBreaks !== 1) return null; // buried-break
    } else {
      if (tailBreaks !== 0) return null; // buried-break
      const abrupt = last.k === "return" || last.k === "throw" || last.k === "continue";
      // A normally-completing tail cascades into the next tail (B2). The
      // outermost tail falling out is the switch's own exit, which is fine;
      // anywhere else is refused (minimum subset: no cascades).
      if (!abrupt && s > 0) return null; // cascading-tail-with-arms (B2)
    }
  }

  // Group arms by the tail they start in, skipping empty tails (running an
  // empty T_s then T_{s-1} is running T_{s-1}); below every tail is the exit.
  const normalize = (s0: number): number => {
    let s = s0;
    while (s >= 0 && levels[s]!.tail.length === 0) s--;
    return s;
  };
  const groups = new Map<number, number[]>();
  const exitOrFree: number[] = [];
  classes.forEach((cls, i) => {
    const s = cls.kind === "seg" ? normalize(cls.startSeg) : -1;
    if (s < 0) exitOrFree.push(i);
    else {
      const g = groups.get(s);
      if (g === undefined) groups.set(s, [i]);
      else g.push(i);
    }
  });
  // unreachable-tail: a non-empty tail nothing runs would either vanish or
  // never be reached — refuse rather than reason about dead code.
  for (let s = 0; s <= n; s++) {
    if (levels[s]!.tail.length > 0 && (groups.get(s) ?? []).length === 0) return null;
  }

  const trimmedArm = (i: number): Stmt[] => {
    const its = items(sw.cases[i]!.body);
    const cls = classes[i]!;
    return cls.kind !== "free" && cls.trailing ? its.slice(0, -1) : [...its];
  };
  const trimmedTail = (s: number): readonly Stmt[] => {
    const t = levels[s]!.tail;
    const last = t[t.length - 1];
    return last !== undefined && last.k === "break" && last.label === outer ? t.slice(0, -1) : t;
  };

  const newCases: PlannedArm[] = [];
  for (let s = n; s >= 0; s--) {
    const grp = groups.get(s);
    if (grp === undefined) continue;
    const bodied = grp.filter((i) => trimmedArm(i).length > 0);
    if (bodied.length > 1) return null; // two-bodied-arms-in-group (B1)
    const ordered = [...bodied, ...grp.filter((i) => !bodied.includes(i))];
    const segItems = trimmedTail(s);
    ordered.forEach((i, k) => {
      const isLast = k === ordered.length - 1;
      const arm = sw.cases[i]!;
      newCases.push({ value: arm.value, isString: arm.isString, fallThrough: !isLast, body: isLast ? [...trimmedArm(i), ...segItems] : trimmedArm(i) });
    });
  }
  for (const i of exitOrFree) {
    const arm = sw.cases[i]!;
    newCases.push({ value: arm.value, isString: arm.isString, fallThrough: false, body: trimmedArm(i) });
  }
  const dits = items(sw.default);
  const newDefault = dflt.kind === "exit" && dflt.trailing ? dits.slice(0, -1) : [...dits];
  return { newCases, newDefault };
}

export function match(node: Stmt, ctx: PassContext): RaiseMatch | null {
  if (node.k !== "labeled") return null;
  if (isGeneratorDispatcher(ctx)) return null; // generator-dispatcher — batch 4's rungs own those functions
  const peeled = peel(node);
  if (peeled === null) return null;
  // A5, over the whole matched subtree: every `break` targets a peeled label
  // (label-escapes otherwise) and no `continue` targets one
  // (continue-to-switch-label). This also refuses nests whose arms contain
  // their own labelled sub-structure — generously, per the framework's rule.
  const peeledLabels = new Set(peeled.levels.map((l) => l.label));
  for (const s of postOrder(node)) {
    if (s.k === "break" && !peeledLabels.has(s.label)) return null; // label-escapes
    if (s.k === "continue" && peeledLabels.has(s.label)) return null; // continue-to-switch-label
  }
  if (insideTry(node, ctx)) return null; // switch-in-try (spec §7: refuse rather than measure)
  const planned = plan(peeled);
  if (planned === null) return null;
  const start = ctx.structured?.graph.blocks[peeled.sw.cfgBlock]?.block?.start ?? 0;
  return { root: node, nodes: [node], data: { rule: "S1", peeled, newCases: planned.newCases, newDefault: planned.newDefault }, at: { functionIndex: ctx.functionIndex, offset: start } };
}

/** `switch-in-try`: is the matched nest anywhere inside a `try`? Moving a
 *  segment into the switch can widen the try's lexical extent and turn a
 *  guard-free try into a guarded one (spec §7 / §8 Q4). */
function insideTry(node: Stmt, ctx: PassContext): boolean {
  if (ctx.parentOf !== undefined) {
    for (let p = ctx.parentOf(node); p !== null; p = ctx.parentOf(p.parent)) {
      if ((p.parent as Stmt).k === "try") return true;
    }
    return false;
  }
  // Unit tests may supply no parent lookup; scan the whole tree instead.
  const root = ctx.structured?.root;
  if (root === undefined) return false;
  return postOrder(root).some((t) => t.k === "try" && postOrder(t).includes(node));
}

/** `generator-dispatcher`, memoised per tree root (same rule as if-chain). */
const dispatcherCache = new WeakMap<Stmt, boolean>();
function isGeneratorDispatcher(ctx: PassContext): boolean {
  const root = ctx.structured?.root;
  if (root === undefined) return false;
  let v = dispatcherCache.get(root);
  if (v === undefined) {
    v = postOrder(root).some((s) => s.k === "switch" && (s.scrutinee.t === "generator-state" || s.scrutinee.t === "dispatch"));
    dispatcherCache.set(root, v);
  }
  return v;
}
