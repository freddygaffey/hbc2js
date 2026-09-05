// super-call matcher -- docs/specs/passes/28-super-call.md, readability row R14.
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
import type { Expr, Param, Stmt } from "../ast.ts";
import { identUses, mapStmts, stmtLists, walk } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

export type ClassExpr = Extract<Expr, { k: "class" }>;

export interface SuperCallGroup {
  /** Display name of every class whose constructor this rung rewrote. */
  readonly folded: readonly string[];
}

export interface SuperRefusal {
  readonly code: string;
  readonly reason: string;
}

/** Every recovered `class` node in `stmts`, in tree order. */
export function classesIn(stmts: readonly Stmt[]): readonly ClassExpr[] {
  const found: ClassExpr[] = [];
  walk(stmts, { expr: (e) => { if (e.k === "class") found.push(e); } });
  return found;
}

/** The class's own `constructor` member, exactly as `class-recover` installs it. */
export function ctorMember(cls: ClassExpr): Extract<Expr, { k: "func" }> | null {
  const m = cls.members.find((m) => m.kind === "method" && !m.static && m.key.k === "ident" && m.key.name === "constructor");
  return m !== undefined && m.value !== null && m.value.k === "func" ? m.value : null;
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

/** `deref`, chased through the emitter's register-to-register moves: the
 *  forward's operands reach the call through up to a few `Mov`s
 *  (`r5 = r2; r3 = r1; applyArguments(arguments, r5, r4, r3)`). Each hop
 *  resolves against the stores that precede the hop it came from, never a
 *  later one, so a register reused after its move is never followed. Stops at
 *  an identifier with no preceding store (an env slot, a parameter) and
 *  returns it. */
function derefChain(body: readonly Stmt[], upto: number, e: Expr): Expr {
  let cur = e;
  let bound = upto;
  for (let hop = 0; hop < 4 && cur.k === "ident"; hop++) {
    let found = -1;
    for (let i = bound - 1; i >= 0; i--) {
      const st = simpleStore(body[i]!);
      if (st !== null && st.name === (cur as { name: string }).name) { found = i; break; }
    }
    if (found < 0) return cur;
    cur = simpleStore(body[found]!)!.value;
    bound = found;
  }
  return cur;
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

/** The emitter's own spelling of the `applyArguments` intrinsic
 *  (`src/emit/builtins.ts` INTRINSIC_HELPERS). A forward spelled any other way
 *  is not this emitter's output, so the rung never claims it (R-SC0). */
export const APPLY_ARGUMENTS = "__hbc_b_applyArguments";

/** The rest parameter the rebuilt implicit constructor declares. Section 9 of
 *  the spec: the body it lands in contains no other name, so this binding can
 *  shadow nothing that is read. */
const FORWARD_PARAM = "args";

/** `arguments` occurrences anywhere in `stmts`, nested frames included. */
function argumentsUses(stmts: readonly Stmt[]): number {
  let n = 0;
  walk(stmts, { expr: (e) => { if (e.k === "argumentsObject") n++; } });
  return n;
}

/**
 * The implicit/forwarding derived constructor (spec 28 section 9): hermesc
 * compiles a derived class with NO constructor of its own -- and an explicit
 * `constructor(...a) { super(...a); }`, which it lowers identically -- to
 *
 *     return __hbc_b_applyArguments(arguments, Object.getPrototypeOf(_eD_S), undefined, new.target);
 *
 * The helper (`src/runtime/helpers.ts`) is
 * `Reflect.construct(fn, slice(callerArgs), newTarget)` whenever `newTarget`
 * is not undefined, which is every construct call -- and a class constructor
 * cannot be reached any other way (13.3 throws before the body runs). That is
 * ES2024 15.7.14 step 14's default derived constructor byte for byte, so the
 * rewrite to `constructor(...args) { super(...args); }` is an identity given
 * what this function proves: the forwarded target is this class's own
 * `Object.getPrototypeOf(<binding>)` (the section 4 evidence, unchanged), the
 * new.target is the frame's own literal, the `arguments` object is the one the
 * forward consumes and is read nowhere else, and the constructor declares no
 * parameters of its own.
 */
function foldForwardBody(module: readonly Stmt[], cls: ClassExpr, body: readonly Stmt[], params: readonly Param[]): { readonly body: readonly Stmt[]; readonly params: readonly Param[] } | SuperRefusal {
  // Shape: the forward is the constructor's LAST statement, and everything
  // before it is inert -- the `// fn#N` provenance comment (kept), the
  // "use strict" directive (DROPPED: the rebuilt constructor has a non-simple
  // parameter list and ES2024 15.2.1 forbids a directive prologue there; a
  // no-op, since a class body is strict code already, ES2024 15.7), a hoisted
  // `function` declaration this frame merely hosts (kept -- a declaration runs
  // no user code and is legal before `super()`), a register `let` (kept only
  // if something still reads it), and the operand moves the forward itself
  // consumed (deleted, exactly as the main path deletes its own). Anything
  // else is refused rather than guessed at.
  const at = body.length - 1;
  const ret = body[at];
  if (ret === undefined || ret.k !== "return" || ret.arg === null || ret.arg.k !== "call") return { code: "R-SC9", reason: "the applyArguments forward is not the constructor's last statement" };
  const call = ret.arg;
  if (!isIdentNamed(call.callee, APPLY_ARGUMENTS)) return { code: "R-SC9", reason: "the constructor's last statement is not the applyArguments forward" };
  if (params.length > 0) return { code: "R-SC9", reason: `the forwarding constructor declares ${params.length} parameter(s) of its own` };
  if (argumentsUses(body) !== 1) return { code: "R-SC9", reason: "`arguments` is read somewhere other than the forward itself" };
  let head: readonly Stmt[] = [];
  for (let i = 0; i < at; i++) {
    const st = body[i]!;
    if (st.k === "comment" || st.k === "func" || st.k === "decl") { head = [...head, st]; continue; }
    if (st.k === "directive") {
      if (st.text !== "use strict") return { code: "R-SC9", reason: `the forwarding constructor carries the directive "${st.text}", which the rebuilt non-simple parameter list cannot keep` };
      continue;
    }
    const store = simpleStore(st);
    if (store === null || (!isInertValue(store.value) && !isObjectCall(store.value, "getPrototypeOf", 1))) return { code: "R-SC9", reason: "the forwarding constructor runs a statement the forward did not consume" };
    head = [...head, st];
  }

  if (call.args.length !== 4) return { code: "R-SC8", reason: `the applyArguments forward takes ${call.args.length} arguments, not the measured 4` };
  const [callerArgs, target, thisArg, newTarget] = call.args as readonly Expr[];
  if (callerArgs!.k !== "argumentsObject") return { code: "R-SC8", reason: "the forwarded argument list is not the constructor's own arguments object" };
  const ta = derefChain(body, at, thisArg!);
  if (ta.k !== "lit" || ta.text !== "undefined") return { code: "R-SC8", reason: "the forward passes a receiver, so it is not the construct path" };
  const nt = derefChain(body, at, newTarget!);
  if (nt.k !== "lit" || nt.text !== "new.target") return { code: "R-SC8", reason: "the new.target argument is not the constructor's own new.target" };
  const callee = derefChain(body, at, target!);
  if (!isObjectCall(callee, "getPrototypeOf", 1)) return { code: "R-SC8", reason: "the forwarded target is not Object.getPrototypeOf(<class>)" };
  const bindingRef = callee.args[0]!;
  const binding = bindingRef.k === "ident" && ENV_SLOT.test(bindingRef.name) ? bindingRef : derefChain(body, at, bindingRef);
  if (binding.k !== "ident") return { code: "R-SC8", reason: "the forwarded target is not a single binding this rung can resolve" };
  if (!classBindingSlots(module, cls).has(binding.name)) return { code: "R-SC8", reason: `the forwarded target reads ${binding.name}, which is not provably this class's own binding` };

  // The operand moves are dead once the forward is a `super(...)`. Deleted one
  // at a time, in reverse, and only when nothing that survives -- a later head
  // statement, a nested closure -- still reads the target. A store that cannot
  // be deleted is a store this rung does not understand: refuse rather than
  // leave it (R-SC9).
  for (let i = head.length - 1; i >= 0; i--) {
    const st = simpleStore(head[i]!);
    if (st === null) continue;
    const rest = head.slice(i + 1);
    if (identUses(rest, st.name).reads > 0 || mentionedInNestedFunction(rest, st.name)) return { code: "R-SC9", reason: `the forwarding constructor's store to ${st.name} is still read after the forward is rebuilt` };
    head = [...head.slice(0, i), ...rest];
  }
  // Register declarations nothing reads any more go with them.
  head = head.filter((st) => st.k !== "decl" || st.names.some((n) => identUses(head, n).reads + identUses(head, n).writes > 0));

  // The rest parameter must shadow nothing a surviving statement reads.
  let param = FORWARD_PARAM;
  for (let n = 2; identUses(head, param).reads + identUses(head, param).writes > 0; n++) param = `${FORWARD_PARAM}${n}`;

  const spread: Expr = { k: "spread", arg: { k: "ident", name: param } };
  const superStmt: Stmt = { k: "expr", expr: { k: "call", callee: SUPER, args: [spread] } };
  return { body: [...head, superStmt], params: [{ name: param, rest: true }] };
}

/** Rewrites one derived-class constructor body, or explains why not. Pure. */
export function foldSuperBody(module: readonly Stmt[], cls: ClassExpr, body: readonly Stmt[], params: readonly Param[] = []): { readonly body: readonly Stmt[]; readonly params?: readonly Param[] } | SuperRefusal {
  if (cls.superClass === null) return { code: "R-SC0", reason: "base class: there is no super() to rebuild" };

  // One super site, and it must be a top-level store in the constructor's own
  // frame. Anything else -- a second Reflect.construct (conditional super), one
  // buried in a loop/try/closure -- is refused rather than guessed at.
  let sites = 0;
  walk(body, { expr: (e) => { if (reflectConstruct(e) !== null) sites++; } });
  let forwards = false;
  walk(body, { expr: (e) => { if (e.k === "call" && isIdentNamed(e.callee, APPLY_ARGUMENTS)) forwards = true; } });
  if (forwards) return foldForwardBody(module, cls, body, params);
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
    const outcome = foldSuperBody(before, cls, ctor.body, ctor.params);
    if ("code" in outcome) {
      if (outcome.code !== "R-SC0") onRefusal?.(cls, outcome);
      continue;
    }
    const members = cls.members.map((m) => (m.value === ctor ? { ...m, value: { ...ctor, params: outcome.params ?? ctor.params, body: outcome.body } } : m));
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
