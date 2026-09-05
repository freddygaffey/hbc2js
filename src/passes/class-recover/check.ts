// class-recover checker -- spec 24 section 3.4, the *class-shape* obligation
// (00-LADDER.md section 4.3). This rung deletes call effects and moves
// function declarations, so `expressionOnlyCheck` cannot be its guard.
import type { Stmt } from "../ast.ts";
import { effectSequence, freeNames, parses } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { buildAfter, match } from "./match.ts";

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  // 3. Independent re-derivation: recompute the group from `before` by
  // section 3.1's rule and require the same answer -- never trust the
  // writer's own data.
  const m = match(before, { ...ctx, fnBody: before });
  if (m === null) return { ok: false, reason: "class-recover produced no site to re-derive the group from" };
  const g = m.data;

  // 4. Constructor identity (F24-4): the class's constructor is the function
  // index the class-creation instruction named, and the bytecode agrees it is
  // a constructor. A mismatch is a refusal, never a warning.
  const meta = ctx.functionMeta?.(g.site.ctorFnIdx) ?? null;
  if (meta === null || meta.role !== "ctor") return { ok: false, reason: "class-recover: the constructor's bytecode role is not ctor" };

  // 1. Undo: rebuild `after` from the re-derived group and require it to be
  // exactly what the writer produced. Any edit outside the declared group
  // fails here.
  const rebuilt = buildAfter(before, g);
  if (rebuilt.length !== after.length) return { ok: false, reason: "class-recover changed a statement count the group does not account for" };
  for (let i = 0; i < after.length; i++) {
    if (rebuilt[i] === after[i]) continue;
    if (!sameStatement(rebuilt[i]!, after[i]!)) return { ok: false, reason: `class-recover rewrote statement ${i}, which its group does not own` };
  }

  // 2. Effect sequence modulo the declared deletions. Two halves, because
  // "in order, and nothing else" is two claims. (a) Positional: the effects
  // of `after` are the effects of `before` with exactly the declared
  // statement indices dropped and the head statement's own effects
  // substituted -- so a splice that dropped or duplicated any other statement
  // fails here. (b) Kind: every dropped statement is one of the three things
  // a class body reproduces -- an owned `Object.defineProperty` /
  // `Object.setPrototypeOf` call, a moved method/constructor declaration, or
  // the register store that fed one of those -- and nothing else. A class
  // body defines the same own properties, with the same descriptors, in the
  // same order, that those calls defined.
  const drop = new Set(g.deleted);
  const headPos = g.deleted.filter((i) => i < g.headIndex).length;
  const expected: unknown[] = [];
  for (let i = 0; i < before.length; i++) {
    if (drop.has(i)) continue;
    expected.push(...effectSequence([i === g.headIndex ? rebuilt[headPos]! : before[i]!]));
  }
  const got = effectSequence(after);
  if (JSON.stringify(got) !== JSON.stringify(expected)) return { ok: false, reason: "class-recover changed the effect sequence beyond the group it declared" };
  for (const i of g.deleted) {
    const s = before[i]!;
    if (s.k === "func" && g.movedNames.includes(s.name)) continue;
    if (s.k !== "expr") return { ok: false, reason: `class-recover deleted statement ${i}, which is not an install it owns` };
    if (s.expr.k === "assign" && s.expr.value.k === "ident" && g.movedNames.includes(s.expr.value.name)) continue;
    const call = s.expr;
    const owned = call.k === "call" && call.callee.k === "member" && !call.callee.computed && call.callee.obj.k === "ident" && call.callee.obj.name === "Object" && call.callee.prop.k === "lit" && (call.callee.prop.text === "defineProperty" || call.callee.prop.text === "setPrototypeOf");
    if (!owned) return { ok: false, reason: `class-recover deleted statement ${i}, which is not an install it owns` };
  }

  // 3 (continued): no new free name, every moved declaration gone, and the
  // result still parses.
  const beforeFree = freeNames(before);
  for (const name of freeNames(after)) if (!beforeFree.has(name)) return { ok: false, reason: `class-recover introduced the free name ${name}` };
  for (const name of g.movedNames) if (after.some((s) => s.k === "func" && s.name === name)) return { ok: false, reason: `class-recover moved ${name} into a class body but left its declaration behind` };
  if (!parses(after)) return { ok: false, reason: "class-recover produced a body that does not parse" };
  return { ok: true };
}

/** Structural equality, used only where identity already failed. */
function sameStatement(a: Stmt, b: Stmt): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

