// ctor-this matcher -- docs/specs/passes/26-ctor-this.md, readability row R12.
//
// A Hermes base-class constructor allocates its own receiver: the body opens
// with `GetNewTarget` + `GetById "prototype"` + `NewObjectWithParent`, keeps
// the allocated object in a register, and returns it. `src/emit/lower.ts`
// lowers that faithfully (`NewObjectWithParent` -> `Object.create(p === null
// ? null : typeof p === "object" ? p : Object.prototype)`), so a recovered
// `class` currently reads
//
//     constructor(a1) {
//       let r1 = new.target.prototype;
//       r1 = Object.create(r1 === null ? null : typeof r1 === "object" ? r1 : Object.prototype);
//       r1.x = a1;
//       return r1;
//     }
//
// For a BASE class that register is, by definition, the value the language
// itself binds to `this` on entry: [[Construct]] runs
// OrdinaryCreateFromConstructor(newTarget, "%Object.prototype%") before the
// body, which is exactly `Object.create(new.target.prototype)`, and an
// explicit `return <that object>` from a base constructor is what `new`
// yields anyway. So the whole stand-in can be replaced by the real `this`
// with no observable change -- and doing so is what lets `private-fields`
// fold `AddOwnPrivateBySym` back into a real `#name` declaration, since a
// native private field can only ever brand the object the class's own
// [[Construct]] created (docs/BUGS.md 2026-09-01 "class private fields").
//
// Refusals (spec 26 section 6): a derived class (`superClass !== null`) --
// its `this` comes from `super()`, never from an allocation of its own, so
// there is nothing here to prove (R-CT1); the `Object.assign(Object.create(
// new.target.prototype), {...})` seeded form 32-class-basic compiles to,
// which folds a field-initialiser buffer into the allocation (R-CT2); a
// register that is written anywhere else in the frame, or returned from only
// some paths (R-CT3/R-CT4); and a stand-in register mentioned inside a nested
// closure, where the same register NUMBER is a different frame's local and
// substituting `this` would be a silent miscompile (R-CT5).
import type { Expr, Stmt } from "../ast.ts";
import { identUses, mapStmts, stmtLists, walk } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

export interface CtorThisGroup {
  /** Display name of every class whose constructor this rung rewrote, in
   *  tree order (`"<anonymous>"` for a class expression with no name). */
  readonly folded: readonly string[];
}

type ClassExpr = Extract<Expr, { k: "class" }>;

const THIS: Expr = { k: "this" };

function isIdentNamed(e: Expr, name: string): boolean {
  return e.k === "ident" && e.name === name;
}

/** A statement storing into one named variable, in either spelling the
 *  emitter uses (`k:"init"` the first time, `k:"expr"` + `assign` after). */
function simpleStore(s: Stmt): { readonly name: string; readonly value: Expr } | null {
  if (s.k === "init") return { name: s.name, value: s.value };
  if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident") return { name: s.expr.target.name, value: s.expr.value };
  return null;
}

/** `new.target.prototype` -- `new.target` is a `lit` node (`src/emit/function.ts`
 *  `newTargetExpr`), so this is a non-computed member on that literal. */
function isNewTargetPrototype(e: Expr): boolean {
  if (e.k !== "member" || e.computed) return false;
  return e.obj.k === "lit" && e.obj.text === "new.target" && e.prop.k === "lit" && e.prop.text === "prototype";
}

/** `Object.create(<reg> === null ? null : typeof <reg> === "object" ? <reg> :
 *  Object.prototype)` -- `NewObjectWithParent`'s lowering, byte for byte
 *  (`src/emit/lower.ts`'s `NewObjectWithParent` case). */
function isNewObjectWithParent(e: Expr, reg: string): boolean {
  if (e.k !== "call" || e.args.length !== 1) return false;
  const callee = e.callee;
  if (callee.k !== "member" || callee.computed || callee.obj.k !== "ident" || callee.obj.name !== "Object") return false;
  if (callee.prop.k !== "lit" || callee.prop.text !== "create") return false;
  const outer = e.args[0]!;
  if (outer.k !== "cond") return false;
  if (outer.test.k !== "bin" || outer.test.op !== "===" || !isIdentNamed(outer.test.left, reg) || outer.test.right.k !== "lit" || outer.test.right.text !== "null") return false;
  if (outer.then.k !== "lit" || outer.then.text !== "null") return false;
  const inner = outer.else;
  if (inner.k !== "cond") return false;
  if (inner.test.k !== "bin" || inner.test.op !== "===") return false;
  const typeOf = inner.test.left;
  if (typeOf.k !== "unary" || typeOf.op !== "typeof " || !isIdentNamed(typeOf.arg, reg)) return false;
  if (inner.test.right.k !== "lit" || inner.test.right.text !== '"object"') return false;
  if (!isIdentNamed(inner.then, reg)) return false;
  const fallback = inner.else;
  return fallback.k === "member" && !fallback.computed && fallback.obj.k === "ident" && fallback.obj.name === "Object" && fallback.prop.k === "lit" && fallback.prop.text === "prototype";
}

/** The class's own `constructor` member, exactly as `class-recover` installs
 *  it (and as `private-fields` finds it). */
function ctorMember(cls: ClassExpr): Extract<Expr, { k: "func" }> | null {
  const m = cls.members.find((m) => m.kind === "method" && !m.static && m.key.k === "ident" && m.key.name === "constructor");
  return m !== undefined && m.value !== null && m.value.k === "func" ? m.value : null;
}

/** True when `reg` appears as an identifier inside ANY nested `func` body
 *  reachable from `body`. A register name never denotes the same binding
 *  across a function boundary (`IdentUses.nested`'s doc comment: Hermes
 *  restarts `r0` per function), so such an occurrence is a *different*
 *  variable that `mapStmts`'s frame-blind substitution would rewrite to
 *  `this` anyway -- R-CT5 refuses instead. */
function mentionedInNestedFunction(body: readonly Stmt[], reg: string): boolean {
  let found = false;
  const scanFunc = (fnBody: readonly Stmt[]): void => {
    walk(fnBody, { expr: (n) => { if (isIdentNamed(n, reg)) found = true; } });
  };
  walk(body, {
    stmt: (s) => { if (s.k === "func") scanFunc(s.body); },
    expr: (e) => { if (e.k === "func") scanFunc(e.body); },
  });
  return found;
}

/** True when `name` is declared by this body itself -- a bare `let a, b;`
 *  prologue or the `k:"init"` spelling -- rather than inherited from an
 *  enclosing scope. `stmtLists` stops at a `func` boundary, so a nested
 *  closure's own declaration of the same name never counts. */
function declaredInBody(body: readonly Stmt[], name: string): boolean {
  for (const list of stmtLists(body)) {
    for (const s of list) {
      if (s.k === "decl" && s.names.includes(name)) return true;
      if (s.k === "init" && s.name === name) return true;
    }
  }
  return false;
}

/** Stores to `reg` whose value can never be read: the statement is a call
 *  store and the very next statement in the SAME list is an unconditional
 *  `throw`. Hermes emits exactly one of these per constructor that
 *  brand-checks itself -- `r1 = __hbc_b_throwTypeError("Cannot initialize
 *  private field twice."); throw new Error("hbc2js: unreachable");` -- and
 *  the store is pure noise there: the helper never returns. Counting them
 *  lets the writes guard below stay exact (two writes plus these) and the
 *  writer demote each one to a bare expression statement, which is what
 *  keeps the substituted body legal JS (`this = f()` is not). */
function deadStoresTo(body: readonly Stmt[], reg: string): number {
  let n = 0;
  for (const list of stmtLists(body)) {
    for (let i = 0; i < list.length; i++) {
      const store = simpleStore(list[i]!);
      if (store === null || store.name !== reg || store.value.k !== "call") continue;
      if (list[i + 1]?.k === "throw") n++;
    }
  }
  return n;
}

/** Every `return` in the constructor's OWN frame: `stmtLists` stops at a
 *  `func` boundary, so a nested closure's returns are never counted. */
function frameReturns(body: readonly Stmt[]): readonly Extract<Stmt, { k: "return" }>[] {
  const out: Extract<Stmt, { k: "return" }>[] = [];
  for (const list of stmtLists(body)) for (const s of list) if (s.k === "return") out.push(s);
  return out;
}

export interface CtorRefusal {
  readonly code: string;
  readonly reason: string;
}

/** Rewrites one base-class constructor body, or explains why not. Pure. */
export function foldCtorBody(cls: ClassExpr, body: readonly Stmt[]): { readonly body: readonly Stmt[] } | CtorRefusal {
  if (cls.superClass !== null) return { code: "R-CT1", reason: "derived class: `this` comes from super(), not from an allocation this rung can prove" };

  // The stand-in must be the first executable statement pair: everything
  // before it may only be a comment, a directive or a bare declaration.
  let at = 0;
  while (at < body.length && (body[at]!.k === "comment" || body[at]!.k === "directive" || body[at]!.k === "decl")) at++;
  const first = at < body.length ? simpleStore(body[at]!) : null;
  if (first === null || !isNewTargetPrototype(first.value)) {
    const seeded = at < body.length ? body[at]! : null;
    const store = seeded === null ? null : simpleStore(seeded);
    if (store !== null && store.value.k === "call") return { code: "R-CT2", reason: "constructor allocates its receiver in a seeded form (Object.assign over Object.create) this rung does not fold yet" };
    return { code: "R-CT0", reason: "constructor does not open with the new.target.prototype stand-in" };
  }
  // Two registers or one: hermesc allocates `new.target.prototype` into its
  // own temporary at v99 (`rP = new.target.prototype; rO = Object.create(rP
  // === null ? ...)`) and reuses a single register at v98. Both are the same
  // allocation; `reg` is whichever one ends up holding the object.
  const protoReg = first.name;
  const second = at + 1 < body.length ? simpleStore(body[at + 1]!) : null;
  if (second === null || !isNewObjectWithParent(second.value, protoReg)) return { code: "R-CT0", reason: "constructor does not open with the new.target.prototype stand-in" };
  const reg = second.name;
  // Both holders must be the constructor's OWN locals. A register name is
  // the usual spelling, but not the guaranteed one: `var-naming` runs on a
  // constructor's own function long before `class-recover` moves its body
  // into the class node, so by the time this rung sees it the pair may
  // already read `prototype`/`create`. What matters is not the spelling but
  // that the name is declared in this body -- substituting `this` for a name
  // that lives in an enclosing scope would rewrite someone else's variable.
  if (!declaredInBody(body, reg) || !declaredInBody(body, protoReg)) return { code: "R-CT0", reason: "the stand-in holder is not declared in the constructor body" };

  // Exactly two writes in this frame: the two statements above. `identUses`
  // counts an `init` and an `assign` target alike and never follows a
  // register into a nested frame, so a third write anywhere -- including one
  // buried inside an expression -- refuses here.
  const uses = identUses(body, reg);
  const dead = deadStoresTo(body, reg);
  const allocWrites = protoReg === reg ? 2 : 1;
  if (uses.writes !== allocWrites + dead) return { code: "R-CT3", reason: `the stand-in register is written ${uses.writes} times, not exactly the ${allocWrites} the allocation needs (plus ${dead} provably dead store(s))` };
  if (mentionedInNestedFunction(body, reg)) return { code: "R-CT5", reason: "the stand-in register name also occurs inside a nested closure, where it is a different frame's local" };

  const returns = frameReturns(body);
  if (returns.length === 0) return { code: "R-CT4", reason: "constructor never returns the stand-in" };
  for (const r of returns) if (r.arg === null || !isIdentNamed(r.arg, reg)) return { code: "R-CT4", reason: "some return does not return the stand-in" };

  const kept = body.filter((_s, i) => i !== at && i !== at + 1);
  // The prototype temporary, when it is a register of its own, must die with
  // the allocation: anything still reading or writing it after the two
  // statements go is a use this rung has not accounted for.
  if (protoReg !== reg) {
    const p = identUses(kept, protoReg);
    if (p.reads + p.writes > 0) return { code: "R-CT3", reason: "the prototype temporary outlives the allocation" };
  }
  // `mapStmts` is post-order, so by the time `fs` sees a statement its own
  // expressions have already had `reg` substituted: a surviving dead store
  // reads as `this = f(...)` (or is still the `init` that declared `reg`),
  // and both are demoted to the bare call. Nothing else can produce a
  // `this` assignment target, and the guard above proved there is no
  // *live* store left to confuse with one.
  const demote = (s: Stmt): Stmt => {
    if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "this") return { ...s, expr: s.expr.value };
    if (s.k === "init" && s.name === reg) return { k: "expr", expr: s.value, ...(s.origin !== undefined ? { origin: s.origin } : {}) };
    if (s.k === "decl") return { ...s, names: s.names.filter((n) => n !== reg && n !== protoReg) };
    return s;
  };
  const substituted = mapStmts(kept, demote, (e) => (isIdentNamed(e, reg) ? THIS : e)).filter((s) => !(s.k === "decl" && s.names.length === 0));
  // A base constructor that falls off its end yields `this`, so a trailing
  // `return this;` is pure noise. Only the tail one goes: an earlier return
  // is a real early exit.
  const last = substituted[substituted.length - 1];
  const out = last !== undefined && last.k === "return" && last.arg !== null && last.arg.k === "this" ? substituted.slice(0, -1) : substituted;
  return { body: out };
}

/** Every recovered `class` node in `before`, in tree order. */
function classesIn(before: readonly Stmt[]): readonly ClassExpr[] {
  const found: ClassExpr[] = [];
  walk(before, { expr: (e) => { if (e.k === "class") found.push(e); } });
  return found;
}

export function foldAll(before: readonly Stmt[], onRefusal?: (cls: ClassExpr, r: CtorRefusal) => void): { readonly after: readonly Stmt[]; readonly folded: readonly string[] } {
  const replacements = new Map<Expr, Expr>();
  const folded: string[] = [];
  for (const cls of classesIn(before)) {
    const ctor = ctorMember(cls);
    if (ctor === null) continue;
    const outcome = foldCtorBody(cls, ctor.body);
    if ("code" in outcome) {
      if (outcome.code !== "R-CT0") onRefusal?.(cls, outcome);
      continue;
    }
    const members = cls.members.map((m) => (m.value === ctor ? { ...m, value: { ...ctor, body: outcome.body } } : m));
    replacements.set(cls, { ...cls, members });
    folded.push(cls.name ?? "<anonymous>");
  }
  if (replacements.size === 0) return { after: before, folded: [] };
  return { after: mapStmts(before, (s) => s, (e) => replacements.get(e) ?? e), folded };
}

export function match(before: readonly Stmt[], ctx: PassContext): Match<readonly Stmt[], CtorThisGroup> | null {
  const { folded } = foldAll(before, (_cls, r) => ctx.refuse?.(before, `${r.code}: ${r.reason}`));
  if (folded.length === 0) return null;
  return { root: before, nodes: [before], data: { folded }, at: { functionIndex: ctx.functionIndex, offset: 0 } };
}
