// super-call matcher -- docs/specs/passes/28-super-call.md, readability row R13.
//
// Hermes lowers a DERIVED constructor's `super(...)` as a four-instruction
// shape (measured on 33-class-inheritance-super v98 function #4 "Dog"):
//
//     GetNewTarget         r3
//     LoadFromEnvironment  r0, <the class's own binding slot>
//     LoadParentNoTraps    r2, r0          ; superclass = getPrototypeOf(Dog)
//     CreateThisForSuper   r1, r2, r3, 0   ; the TDZ stand-in (empty)
//     Mov                  r5, r1          ; the call frame's `this` slot
//     CallWithNewTarget    r0, r2, r3, 2
//     SelectObject         r0, r1, r0
//     LoadConstEmpty       r1
//     ThrowIfThisInitialized r1            ; "super() called twice"
//
// `src/emit/lower.ts` lowers that faithfully, so a recovered derived `class`
// currently reads
//
//     constructor(a1, a2) {
//       let r0, r1, r2, r3, r4, r5;
//       r3 = new.target;
//       r0 = _e0_1;                       // the class's own binding
//       r2 = Object.getPrototypeOf(r0);   // its [[Prototype]] == the superclass
//       r4 = a1;
//       r5 = r1;                          // the still-empty stand-in
//       r0 = Reflect.construct(r2, [r4], r3);
//       r0 = r0;                          // SelectObject, a move
//       r1 = __hbc_empty;
//       if (r1 !== __hbc_empty) { throw new ReferenceError("super() called twice"); }
//       r1 = a2;
//       r0.breed = r1;
//       return r0;
//     }
//
// `Reflect.construct(Object.getPrototypeOf(C), args, new.target)` where `C` is
// the class the constructor belongs to is *exactly* what the SuperCall runtime
// semantics do (ES2024 13.3.7.1: GetSuperConstructor is
// `activeFunction.[[GetPrototypeOf]]()`, then Construct(func, argList,
// newTarget)), so rewriting it to `super(args)` and calling the result `this`
// is an identity -- provided the four things this matcher proves: the argument
// of `getPrototypeOf` really is this class's own binding (R-SC1), there is
// exactly one super site and it dominates the rest of the body (R-SC2/R-SC3),
// the stand-in is never rewritten afterwards and never mentioned in a nested
// frame (R-SC4/R-SC5), and the arguments are a plain list (R-SC7).
import type { Expr, Stmt } from "../ast.ts";
import { identUses, mapStmts, stmtLists, walk } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import { classesIn, ctorMember } from "../ctor-this/match.ts";
import type { ClassExpr } from "../ctor-this/match.ts";

export interface SuperCallGroup {
  /** Display name of every class whose constructor this rung rewrote. */
  readonly folded: readonly string[];
}

export interface SuperRefusal {
  readonly code: string;
  readonly reason: string;
}

const THIS: Expr = { k: "this" };
const ENV_SLOT = /^_e\d+_\d+$/;

/** `super` prints as a bare keyword; the emitter AST has no node for it, and a
 *  `lit` is exactly how `new.target` is already carried (`src/emit/function.ts`). */
export const SUPER: Expr = { k: "lit", text: "super" };

function isIdentNamed(e: Expr, name: string): boolean {
  return e.k === "ident" && e.name === name;
}

/** A statement storing into one named variable, in either spelling the emitter
 *  uses (`k:"init"` the first time, `k:"expr"` + `assign` after). */
function simpleStore(s: Stmt): { readonly name: string; readonly value: Expr } | null {
  if (s.k === "init") return { name: s.name, value: s.value };
  if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident") return { name: s.expr.target.name, value: s.expr.value };
  return null;
}

/** `Object.<name>(...)` -- the emitter's own spelling. */
function isObjectCall(e: Expr, name: string, arity: number): e is Extract<Expr, { k: "call" }> {
  if (e.k !== "call" || e.args.length !== arity) return false;
  const c = e.callee;
  return c.k === "member" && !c.computed && c.obj.k === "ident" && c.obj.name === "Object" && c.prop.k === "lit" && c.prop.text === name;
}

/** `Reflect.construct(callee, argsArray, newTarget)` -- `CallWithNewTarget`'s
 *  lowering, byte for byte (`src/emit/lower.ts`). */
function reflectConstruct(e: Expr): { readonly callee: Expr; readonly args: Expr; readonly newTarget: Expr } | null {
  if (e.k !== "call" || e.args.length !== 3) return null;
  const c = e.callee;
  if (c.k !== "member" || c.computed || c.obj.k !== "ident" || c.obj.name !== "Reflect") return null;
  if (c.prop.k !== "lit" || c.prop.text !== "construct") return null;
  return { callee: e.args[0]!, args: e.args[1]!, newTarget: e.args[2]! };
}

/** The last top-level store to `name` strictly before `upto`, or null. */
function lastStoreBefore(body: readonly Stmt[], upto: number, name: string): Expr | null {
  for (let i = upto - 1; i >= 0; i--) {
    const st = simpleStore(body[i]!);
    if (st !== null && st.name === name) return st.value;
  }
  return null;
}

/** `e` itself, or -- when `e` is a bare identifier -- the value its last
 *  preceding top-level store put there. One hop only: the emitter never
 *  chains more than one move per operand in this shape, and a longer chain is
 *  a shape this rung has not measured. */
function deref(body: readonly Stmt[], upto: number, e: Expr): Expr | null {
  if (e.k !== "ident") return e;
  return lastStoreBefore(body, upto, e.name);
}

/** True when `name` appears as an identifier inside ANY nested `func` body
 *  reachable from `body` -- there it is a different frame's local, and this
 *  rung's frame-blind substitution would be a silent miscompile (R-SC5). */
function mentionedInNestedFunction(body: readonly Stmt[], name: string): boolean {
  let found = false;
  const scanFunc = (fnBody: readonly Stmt[]): void => {
    walk(fnBody, { expr: (n) => { if (isIdentNamed(n, name)) found = true; } });
  };
  walk(body, {
    stmt: (s) => { if (s.k === "func") scanFunc(s.body); },
    expr: (e) => { if (e.k === "func") scanFunc(e.body); },
  });
  return found;
}

/** Every write to `name` anywhere in `stmts`, nested frames included. Used on
 *  the WHOLE module body to prove an env slot holds one value for ever. */
function writesAnywhere(stmts: readonly Stmt[], name: string): number {
  let n = 0;
  walk(stmts, {
    stmt: (s) => { if (s.k === "init" && s.name === name) n++; },
    expr: (e) => { if (e.k === "assign" && e.target.k === "ident" && e.target.name === name) n++; },
  });
  return n;
}

/** A value whose evaluation provably cannot run user code (so it cannot
 *  construct the class between the class expression and the env-slot store). */
function isInertValue(e: Expr): boolean {
  if (e.k === "ident" || e.k === "lit" || e.k === "this") return true;
  if (e.k === "member" && !e.computed && e.prop.k === "lit") return e.obj.k === "ident" || e.obj.k === "lit";
  return false;
}

/**
 * The env-slot names that provably hold `cls` for the whole life of the
 * module: a store `X = <cls>` followed, in the same statement list and with
 * nothing between them that can run user code or overwrite `X`, by
 * `_eD_S = X`, where `_eD_S` is written exactly once anywhere. That is the
 * evidence R-SC1 needs -- the constructor reads the slot from an enclosing
 * frame, so the proof cannot be local to the constructor.
 */
export function classBindingSlots(module: readonly Stmt[], cls: ClassExpr): ReadonlySet<string> {
  const out = new Set<string>();
  for (const list of stmtLists(module)) {
    for (let i = 0; i < list.length; i++) {
      const st = simpleStore(list[i]!);
      if (st === null || st.value !== cls) continue;
      const holder = st.name;
      for (let j = i + 1; j < list.length; j++) {
        const s2 = simpleStore(list[j]!);
        if (s2 === null) break;
        if (s2.value.k === "ident" && s2.value.name === holder) {
          if (ENV_SLOT.test(s2.name) && writesAnywhere(module, s2.name) === 1) out.add(s2.name);
          continue;
        }
        if (s2.name === holder) break;
        if (!isInertValue(s2.value)) break;
      }
    }
  }
  return out;
}

/** `T = __hbc_empty;` immediately followed by
 *  `if (T !== __hbc_empty) { throw new ReferenceError("super() called twice"); }`
 *  -- `LoadConstEmpty` + `ThrowIfThisInitialized`, which hermesc leaves behind
 *  after its own optimiser has proved the branch dead. */
function isSuperTwiceGuard(store: Stmt, guard: Stmt | undefined): string | null {
  const st = simpleStore(store);
  if (st === null || !isIdentNamed(st.value, "__hbc_empty")) return null;
  if (guard === undefined || guard.k !== "if") return null;
  if (guard.else.length !== 0 || guard.then.length !== 1) return null;
  const thrown = guard.then[0]!;
  if (thrown.k !== "throw" || thrown.arg.k !== "new") return null;
  if (!isIdentNamed(thrown.arg.callee, "ReferenceError")) return null;
  if (thrown.arg.args.length !== 1 || thrown.arg.args[0]!.k !== "lit" || thrown.arg.args[0]!.text !== '"super() called twice"') return null;
  const test = guard.test;
  if (test.k !== "bin" || test.op !== "!==") return null;
  if (!isIdentNamed(test.left, st.name) || !isIdentNamed(test.right, "__hbc_empty")) return null;
  return st.name;
}

/** Rewrites one derived-class constructor body, or explains why not. Pure. */
export function foldSuperBody(module: readonly Stmt[], cls: ClassExpr, body: readonly Stmt[]): { readonly body: readonly Stmt[] } | SuperRefusal {
  if (cls.superClass === null) return { code: "R-SC0", reason: "base class: there is no super() to rebuild" };

  // One super site, and it must be a top-level store in the constructor's own
  // frame. Anything else -- a second Reflect.construct (conditional super), one
  // buried in a loop/try/closure -- is refused rather than guessed at.
  let sites = 0;
  walk(body, { expr: (e) => { if (reflectConstruct(e) !== null) sites++; } });
  let forwards = false;
  walk(body, { expr: (e) => { if (e.k === "call" && isIdentNamed(e.callee, "__hbc_b_applyArguments")) forwards = true; } });
  if (forwards) return { code: "R-SC6", reason: "implicit/forwarding derived constructor (super(...arguments) via the applyArguments builtin); not rebuilt yet" };
  if (sites === 0) return { code: "R-SC0", reason: "constructor contains no Reflect.construct super site" };
  if (sites > 1) return { code: "R-SC2", reason: `constructor has ${sites} Reflect.construct sites, so no single super() call dominates the body` };

  let at = -1;
  for (let i = 0; i < body.length; i++) {
    const st = simpleStore(body[i]!);
    if (st !== null && reflectConstruct(st.value) !== null) { at = i; break; }
  }
  if (at < 0) return { code: "R-SC3", reason: "the super site is not a top-level store in the constructor's own frame (closure, loop or try)" };
  const site = reflectConstruct(simpleStore(body[at]!)!.value)!;

  // new.target: the third argument must provably be the constructor's own.
  const nt = deref(body, at, site.newTarget);
  if (nt === null || nt.k !== "lit" || nt.text !== "new.target") return { code: "R-SC1", reason: "the new.target argument is not the constructor's own new.target" };

  // The callee must be `Object.getPrototypeOf(<this class's own binding>)`.
  const callee = deref(body, at, site.callee);
  if (callee === null || !isObjectCall(callee, "getPrototypeOf", 1)) return { code: "R-SC1", reason: "the super constructor is not Object.getPrototypeOf(<class>)" };
  const bindingRef = callee.args[0]!;
  const binding = bindingRef.k === "ident" && ENV_SLOT.test(bindingRef.name) ? bindingRef : deref(body, at, bindingRef);
  if (binding === null || binding.k !== "ident") return { code: "R-SC1", reason: "the getPrototypeOf argument is not a single binding this rung can resolve" };
  if (!classBindingSlots(module, cls).has(binding.name)) return { code: "R-SC1", reason: `the superclass expression reads ${binding.name}, which is not provably this class's own binding` };

  // A plain argument list. The spread/apply variant keeps its lowering.
  if (site.args.k !== "array") return { code: "R-SC7", reason: "the super arguments are not a plain array literal (spread/apply variant)" };
  const args = site.args.elements;
  for (const a of args) if (a.k === "spread") return { code: "R-SC7", reason: "the super arguments contain a spread element" };

  // The stand-in: the register the construct writes, plus the `SelectObject`
  // move that immediately follows it when the two use different registers.
  const dest = simpleStore(body[at]!)!.name;
  const standins = new Set<string>([dest]);
  const consumed = new Set<number>([at]);
  const next = at + 1 < body.length ? simpleStore(body[at + 1]!) : null;
  if (next !== null && isIdentNamed(next.value, dest)) { standins.add(next.name); consumed.add(at + 1); }

  // Delete the dead "super() called twice" guard, and its `T = <empty>` store
  // when nothing can read `T` before the next write to it.
  let guardName: string | null = null;
  for (let i = at + 1; i + 1 < body.length; i++) {
    const name = isSuperTwiceGuard(body[i]!, body[i + 1]);
    if (name === null) continue;
    consumed.add(i + 1);
    const rest = body.slice(i + 2);
    const after = simpleStore(rest[0] ?? { k: "comment", text: "" });
    const deadStore = (after !== null && after.name === name && identUses([{ k: "expr", expr: after.value }], name).reads === 0)
      || (identUses(rest, name).reads + identUses(rest, name).writes === 0 && !mentionedInNestedFunction(rest, name));
    if (deadStore) consumed.add(i);
    guardName = name;
    break;
  }
  void guardName;

  const tailStmts = body.filter((_s, i) => i > at && !consumed.has(i));
  for (const name of standins) {
    if (mentionedInNestedFunction(body, name)) return { code: "R-SC5", reason: `the stand-in register ${name} also occurs inside a nested closure, where it is a different frame's local` };
    if (identUses(tailStmts, name).writes > 0) return { code: "R-SC4", reason: `the stand-in register ${name} is written again after the super call` };
  }

  const superStmt: Stmt = { k: "expr", expr: { k: "call", callee: SUPER, args: [...args] } };
  // The operand stores the super call consumed are dead once it is a `super(...)`:
  // `rN = new.target`, `rN = <the class binding slot>`, `rM = Object.getPrototypeOf(rN)`
  // and the `Mov` into the call frame's `this` slot. Each one is deleted only
  // when its value provably cannot run user code AND its target has no
  // surviving read anywhere -- head, super arguments or tail. The
  // `getPrototypeOf` store qualifies only when it is the very store this site
  // read (a class is never a Proxy, so that one call has no trap to fire).
  const calleeName = site.callee.k === "ident" ? site.callee.name : null;
  let head = body.slice(0, at);
  for (let i = head.length - 1; i >= 0; i--) {
    const st = simpleStore(head[i]!);
    if (st === null) continue;
    const isConsumedGetProto = calleeName !== null && st.name === calleeName && isObjectCall(st.value, "getPrototypeOf", 1);
    if (!isInertValue(st.value) && !isConsumedGetProto) continue;
    if (identUses(head.slice(i + 1), st.name).reads > 0) continue;
    if (args.some((a) => identUses([{ k: "expr", expr: a }], st.name).reads > 0)) continue;
    if (identUses(tailStmts, st.name).reads > 0) continue;
    if (mentionedInNestedFunction(body, st.name)) continue;
    head = [...head.slice(0, i), ...head.slice(i + 1)];
  }
  const tail = mapStmts(tailStmts, (s) => (s.k === "decl" ? { ...s, names: s.names.filter((n) => !standins.has(n) || identUses(body.slice(0, at), n).reads + identUses(body.slice(0, at), n).writes > 0) } : s), (e) => (e.k === "ident" && standins.has(e.name) ? THIS : e))
    .filter((s) => !(s.k === "decl" && s.names.length === 0));
  // A derived constructor that falls off its end yields its `this` binding, and
  // the super() above dominates the end, so a trailing `return this;` is noise.
  const last = tail[tail.length - 1];
  const trimmed = last !== undefined && last.k === "return" && last.arg !== null && last.arg.k === "this" ? tail.slice(0, -1) : tail;
  return { body: [...head, superStmt, ...trimmed] };
}

export function foldAll(before: readonly Stmt[], onRefusal?: (cls: ClassExpr, r: SuperRefusal) => void): { readonly after: readonly Stmt[]; readonly folded: readonly string[] } {
  const replacements = new Map<Expr, Expr>();
  const folded: string[] = [];
  for (const cls of classesIn(before)) {
    const ctor = ctorMember(cls);
    if (ctor === null) continue;
    const outcome = foldSuperBody(before, cls, ctor.body);
    if ("code" in outcome) {
      if (outcome.code !== "R-SC0") onRefusal?.(cls, outcome);
      continue;
    }
    const members = cls.members.map((m) => (m.value === ctor ? { ...m, value: { ...ctor, body: outcome.body } } : m));
    replacements.set(cls, { ...cls, members });
    folded.push(cls.name ?? "<anonymous>");
  }
  if (replacements.size === 0) return { after: before, folded: [] };
  return { after: mapStmts(before, (s) => s, (e) => replacements.get(e) ?? e), folded };
}

export function match(before: readonly Stmt[], ctx: PassContext): Match<readonly Stmt[], SuperCallGroup> | null {
  const { folded } = foldAll(before, (_cls, r) => ctx.refuse?.(before, `${r.code}: ${r.reason}`));
  if (folded.length === 0) return null;
  return { root: before, nodes: [before], data: { folded }, at: { functionIndex: ctx.functionIndex, offset: 0 } };
}
