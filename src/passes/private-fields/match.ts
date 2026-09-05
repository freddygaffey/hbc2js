// private-fields matcher -- docs/specs/passes/24-class-recover.md's private-name
// follow-up, catalogue row 20 (see LOWERING-CATALOGUE.md). `src/emit/lower.ts`'s
// "private names" block lowers every private-name opcode into a *symbol*-keyed
// shape (`CreatePrivateName` -> `Symbol("#x")`, `AddOwnPrivateBySym` ->
// `Object.defineProperty(obj, sym, {value, writable:true, ...})`,
// `Get/PutOwnPrivateBySym` -> `obj[sym]`, `PrivateIsIn` ->
// `Object.prototype.hasOwnProperty.call(obj, sym)`) so the pipeline stays
// behaviour-preserving even where no later rung recognises the shape. This
// rung runs after `class-recover` has already raised the `CreateBaseClass`/
// `CreateDerivedClass` group into a `class` node (F24-1) and folds every
// symbol-keyed private-name shape it owns back into real `#name` syntax --
// field declarations, `obj.#name` reads/writes, `#name in obj` brand checks.
//
// Safety (spec 24's refusal discipline, applied to a private name instead of
// a class member): a candidate name is folded only when *every* reference to
// it anywhere in the enclosing function's tree -- including inside every
// class member's body, which `class-recover` already spliced into this same
// tree -- is one of the four recognised shapes above. Any other reference
// (the name stored into a field, passed to a call, returned, compared, ...)
// refuses that one name; the class's other private names are still tried
// independently, and refusal is silent shape-preservation, never a partial
// rewrite (PL-05: `--passes=none` is untouched either way).
//
// Register aliasing (`r3 = _e0_0;` before a use) is resolved the same way
// class-recover's own `regValues` resolves method keys: an *ordered*
// left-to-right scan (recursing into `if`/`labeled` nesting -- see
// `foldInBody`'s own doc comment), tracking which registers currently hold
// the candidate's value and forgetting one the moment it is reassigned to
// anything else -- never a position-blind "was it ever assigned this" set,
// which would (wrongly) call a register that held a *different* private name
// earlier in the same list an alias of this one too.
import type { Expr, Stmt } from "../ast.ts";
import { identUses, mapStmts, walk } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

export interface PrivateFieldsGroup {
  /** Display name (with the leading `#`) of every candidate this rung
   *  actually folded, in declaration order. */
  readonly folded: readonly string[];
}

type Ident = Extract<Expr, { k: "ident" }>;
type ClassExpr = Extract<Expr, { k: "class" }>;

function isIdent(e: Expr): e is Ident {
  return e.k === "ident";
}

/** `Symbol("#name")` -- the exact shape `CreatePrivateName` lowers to. Returns
 *  the raw name (`"#balance"`, `#` included) or `null`. */
function privateSymbolName(e: Expr): string | null {
  if (e.k !== "call" || e.callee.k !== "ident" || e.callee.name !== "Symbol" || e.args.length !== 1) return null;
  const a = e.args[0]!;
  if (a.k !== "lit" || a.text.length < 4 || a.text[0] !== '"' || a.text[1] !== "#" || a.text[a.text.length - 1] !== '"') return null;
  return a.text.slice(1, -1);
}

/** A statement that stores a value into a single named variable, whichever
 *  of the two shapes the emitter used (`k:"init"` the first time a name is
 *  written, `k:"expr"`+`assign` every time after). */
function simpleStore(s: Stmt): { readonly name: string; readonly value: Expr } | null {
  if (s.k === "init") return { name: s.name, value: s.value };
  if (s.k === "expr" && s.expr.k === "assign" && isIdent(s.expr.target)) return { name: s.expr.target.name, value: s.expr.value };
  return null;
}

/** Every top-level `<ident> = Symbol("#name")` store in `before` -- the
 *  emitter's lowering of `CreatePrivateName` followed by its `StoreToEnvironment`
 *  (`src/emit/lower.ts`'s "private names" block keeps the two as one AST
 *  store, same as every other env-slot write). */
function findCandidates(before: readonly Stmt[]): readonly { readonly envName: string; readonly displayName: string }[] {
  const out: { envName: string; displayName: string }[] = [];
  for (const s of before) {
    const store = simpleStore(s);
    if (store === null) continue;
    const displayName = privateSymbolName(store.value);
    if (displayName !== null) out.push({ envName: store.name, displayName });
  }
  return out;
}

/** The one recovered `class` node in `before`, class-recover's own head
 *  shape (an assignment or `let`-init whose value is `k:"class"`) -- found
 *  generically so this rung does not need to re-derive class-recover's own
 *  group. `null` when there is none, or more than one (ambiguous). */
export function findClass(before: readonly Stmt[]): ClassExpr | null {
  const found: ClassExpr[] = [];
  walk(before, { expr: (e) => { if (e.k === "class") found.push(e); } });
  return found.length === 1 ? found[0]! : null;
}

function ctorBody(cls: ClassExpr): readonly Stmt[] | null {
  const m = cls.members.find((m) => m.kind === "method" && !m.static && m.key.k === "ident" && m.key.name === "constructor");
  return m !== undefined && m.value !== null && m.value.k === "func" ? m.value.body : null;
}

/** `Object.<name>(...)`, the emitter's own spelling (non-computed member on
 *  a bare `Object` ident). */
function objectCall(e: Expr, name: string): readonly Expr[] | null {
  if (e.k !== "call" || e.callee.k !== "member" || e.callee.computed) return null;
  if (e.callee.obj.k !== "ident" || e.callee.obj.name !== "Object") return null;
  const p = e.callee.prop;
  return p.k === "lit" && p.text === name ? e.args : null;
}

/** `Object.prototype.hasOwnProperty.call(obj, key)` -- `hasOwn()` in
 *  `src/emit/lower.ts`, `PrivateIsIn`'s lowering. */
function hasOwnCall(e: Expr): readonly Expr[] | null {
  if (e.k !== "call" || e.callee.k !== "member" || e.callee.computed || e.callee.prop.k !== "lit" || e.callee.prop.text !== "call") return null;
  const target = e.callee.obj;
  if (target.k !== "member" || target.computed || target.prop.k !== "lit" || target.prop.text !== "hasOwnProperty") return null;
  const proto = target.obj;
  if (proto.k !== "member" || proto.computed || proto.prop.k !== "lit" || proto.prop.text !== "prototype") return null;
  return proto.obj.k === "ident" && proto.obj.name === "Object" && e.args.length === 2 ? e.args : null;
}

/** `AddOwnPrivateBySym`'s exact descriptor (`defineProperty()` in
 *  `src/emit/lower.ts`): `{value, writable:true, enumerable:false,
 *  configurable:false}`, in that order, nothing else -- an ordinary
 *  (non-private) instance install never has this exact shape (a class
 *  member's descriptor is `enumerable:false, configurable:true`, spec 24
 *  section 3.1's `readDescriptor`). */
function isTrue(e: Expr): boolean {
  return e.k === "lit" && e.text === "true";
}
function isFalse(e: Expr): boolean {
  return e.k === "lit" && e.text === "false";
}
function privateInstallValue(args: readonly Expr[]): Expr | null {
  if (args.length !== 3) return null;
  const desc = args[2]!;
  if (desc.k !== "object" || desc.props.length !== 4) return null;
  const props = desc.props;
  if (props.some((p) => "k" in p)) return null;
  const named = props as readonly { readonly key: string; readonly computed: boolean; readonly value: Expr }[];
  if (named.some((p) => p.computed)) return null;
  const byKey = new Map(named.map((p) => [p.key, p.value] as const));
  if (byKey.size !== 4) return null;
  const value = byKey.get("value");
  if (value === undefined || !isTrue(byKey.get("writable")!) || !isFalse(byKey.get("enumerable")!) || !isFalse(byKey.get("configurable")!)) return null;
  return value;
}

interface FoldOutcome {
  readonly body: readonly Stmt[];
  readonly initExpr: Expr | null;
}

/** Folds one candidate's uses inside a *single* member body: `allowInstall`
 *  is true only for the constructor, the one place `AddOwnPrivateBySym`
 *  (the field's declare-and-initialise) can appear. Returns `null` on any
 *  reference this rung does not recognise -- the escape refusal.
 *
 *  The scan is sequential and *recurses* into `if`/`labeled` nesting (a
 *  `labeled` block is straight-line code with a `break` target, not a
 *  branch, so its aliases flow back out; an `if`'s two arms are forked
 *  independently from the same entry state and neither's own updates
 *  leaks to what follows -- withdraw's guard clause reassigns its `r0` to
 *  `globalThis` on the throwing arm only, and the surviving `r0` after the
 *  `if` is still this candidate's alias). Anything this rung has no
 *  fixture shape for yet (`while`/`for`/`switch`/`try`) is scanned as one
 *  leaf with the entry alias set, same as a single statement -- correct as
 *  long as no register is repurposed *inside* it, which no committed
 *  fixture does; a future one that does would need this recursion
 *  extended to match, not a silent wrong rewrite, because the escape scan
 *  below still runs over its full (unrecursed) subtree and refuses any
 *  reference it cannot place. */
function foldInBody(body: readonly Stmt[], envName: string, displayName: string, allowInstall: boolean): FoldOutcome | null {
  // A `lit` node, not an `ident`: `member`'s non-computed printer reads
  // `.text` off whatever `prop` is regardless of its `k` (`src/emit/print.ts`),
  // and `walk`'s "member" case visits `prop` unconditionally, so an `ident`
  // here would both print wrong (no `.text`) and read as a captured free
  // variable named `#balance` to `freeNames` -- neither problem exists for a
  // bare `lit` (`classMemberKey` and `render` both print a `lit`'s `.text`
  // as-is, and only `ident` nodes count as a use in `freeNames`).
  const displayKey = (): Expr => ({ k: "lit", text: displayName });
  let initExpr: Expr | null = null;
  let installs = 0;
  let escaped = false;
  const droppedInits: string[] = [];

  // General register-value resolution (class-recover's own `regValues`
  // technique) for the install's `value` argument, which is a bare register
  // reference (`Object.defineProperty(r1, r3, {value: r0, ...})`), not the
  // literal initialiser -- resolved the same way, forked the same way.
  const resolve = (regs: ReadonlyMap<string, Expr>, e: Expr): Expr => (isIdent(e) ? (regs.get(e.name) ?? e) : e);
  // A `AddOwnPrivateBySym`/`Object.defineProperty` install is only safe to
  // fold into a real class-field declaration when its target resolves to
  // the literal `this` -- native private fields can only ever be added to
  // an object during ITS OWN class's [[Construct]] (auto-initialised on
  // `this` before the constructor body runs, or by `this.#x = v` field
  // syntax executed while `this` is bound to that exact object). Several of
  // this codebase's decompiled base-class constructors instead build a
  // *separate* plain object (`let r1 = Object.create(new.target.prototype);
  // ...; return r1;`) and explicitly return it, discarding the real `this`
  // -- a completely valid, common Hermes lowering (support for
  // `Reflect.construct`/`new.target` polymorphism), but one where `r1`
  // never receives the class's private-field brand at all. Folding
  // `Object.defineProperty(r1, sym, {...})` into `#x;` there is a silent
  // behaviour change: `r1.#x = v` throws `TypeError: Cannot write private
  // member #x to an object whose class did not declare it` (found by the
  // T2 equivalence gate, tests/gate/decompile/equivalence.test.ts,
  // fixture 35 -- traces diverge at record 0, the `new BankAccount(...)`
  // call itself). `Object.defineProperty` with a `Symbol` key has no such
  // restriction (it writes to whatever object it is given), which is
  // exactly why that shape is the correct, safe fallback and this rung
  // must refuse rather than "fix" it.
  const isThisArg = (e: Expr, regs: ReadonlyMap<string, Expr>): boolean => resolve(regs, e).k === "this";
  const regSources = new Map<string, Stmt>();
  const claimedSources = new Set<Stmt>();
  const resolveClaim = (regs: ReadonlyMap<string, Expr>, e: Expr): Expr => {
    if (isIdent(e) && regs.has(e.name)) {
      const src = regSources.get(e.name);
      // Only claim (and so delete) the source statement when this register
      // has exactly one use in the whole body -- the constructor's "BankAccount"
      // brand install and a real field's install can share one `let rN =
      // undefined;` temporary (hermesc reuses a register across sibling
      // `AddOwnPrivateBySym` calls with the same literal value), and deleting
      // a still-shared declaration would leave the other install reading an
      // undeclared name.
      if (src !== undefined) {
        let uses = 0;
        walk(body, { expr: (n) => { if (isIdent(n) && n.name === e.name) uses++; } });
        if (uses === 1) claimedSources.add(src);
      }
      return regs.get(e.name)!;
    }
    return e;
  };

  /** Scans and rewrites one expression subtree in place (an `if`'s test, or
   *  the whole of any other statement's own expressions via `mapExpr`). Marks
   *  every recognised-shape key as consumed, flags an escape for any other
   *  reference to a live alias, and returns the rewritten node. */
  function processExpr(e: Expr, aliases: ReadonlySet<string>, regs: ReadonlyMap<string, Expr>, assignTarget: Expr | null): Expr {
    const consumed = new Set<Expr>();
    walk([{ k: "expr", expr: e }], {
      expr: (n) => {
        if (n.k === "member" && n.computed && isIdent(n.prop) && aliases.has(n.prop.name)) {
          consumed.add(n.prop);
          return;
        }
        const hasOwnArgs = hasOwnCall(n);
        if (hasOwnArgs !== null && isIdent(hasOwnArgs[1]!) && aliases.has((hasOwnArgs[1] as Ident).name)) {
          consumed.add(hasOwnArgs[1]!);
          return;
        }
        if (allowInstall) {
          const defineArgs = objectCall(n, "defineProperty");
          if (defineArgs !== null && defineArgs.length === 3 && isIdent(defineArgs[1]!) && aliases.has((defineArgs[1] as Ident).name) && isThisArg(defineArgs[0]!, regs)) {
            const value = privateInstallValue(defineArgs);
            if (value !== null) {
              consumed.add(defineArgs[1]!);
              initExpr = resolveClaim(regs, value);
              installs++;
            }
          }
        }
      },
    });
    walk([{ k: "expr", expr: e }], {
      expr: (n) => {
        if (!isIdent(n) || !aliases.has(n.name) || consumed.has(n)) return;
        if (n === assignTarget) return; // a plain reassignment target (case b)
        escaped = true;
      },
    });
    const fx = (n: Expr): Expr => {
      if (n.k === "member" && n.computed && isIdent(n.prop) && aliases.has(n.prop.name)) return { ...n, prop: displayKey(), computed: false };
      const hasOwnArgs = hasOwnCall(n);
      if (hasOwnArgs !== null && isIdent(hasOwnArgs[1]!) && aliases.has((hasOwnArgs[1] as Ident).name)) return { k: "bin", op: "in", left: displayKey(), right: hasOwnArgs[0]! };
      return n;
    };
    return mapExprFully(e, fx);
  }

  function mapExprFully(e: Expr, fx: (e: Expr) => Expr): Expr {
    const wrapped = mapStmts([{ k: "expr", expr: e }], (s) => s, fx)[0] as Extract<Stmt, { k: "expr" }>;
    return wrapped.expr;
  }

  /** Advances the alias/register state one plain statement's worth, without
   *  descending into `if`/`labeled` (the caller, `fold`, handles those). */
  function step(s: Stmt, aliases: ReadonlySet<string>, regs: ReadonlyMap<string, Expr>): { readonly stmt: Stmt | null; readonly aliasesOut: ReadonlySet<string>; readonly regsOut: ReadonlyMap<string, Expr> } {
    const store = simpleStore(s);

    // (a) A pure copy of a live alias into a fresh register: extend the
    // alias set and drop the statement (see the doc comment above).
    if (store !== null && isIdent(store.value) && aliases.has(store.value.name)) {
      // The dropped statement may be the register's *declaration* (`let r0 =
      // _e0_0;`, the `k:"init"` spelling) while a later statement in the same
      // body repurposes the same register for something else (`withdraw`'s
      // `r0 = globalThis;` on fixture 35's throwing arm). Dropping the
      // declaration with the statement leaves that assignment undeclared,
      // which in a class body -- always strict -- is a ReferenceError at run
      // time. Remembered here and re-declared once, as a bare `let`, in front
      // of the folded body, but only if a reference really does survive the
      // fold (see `redeclare` below). Found when `ctor-this` first let this
      // rung fire on a real fixture.
      if (s.k === "init") droppedInits.push(s.name);
      return { stmt: null, aliasesOut: new Set(aliases).add(store.name), regsOut: regs };
    }
    let nextAliases = aliases;
    let nextRegs = regs;
    if (store !== null) {
      if (aliases.has(store.name)) nextAliases = new Set([...aliases].filter((n) => n !== store.name)); // (b) repurposed
      // Recorded so an install that consumes this register's value can
      // claim (delete) the statement that produced it, rather than
      // duplicating a possibly-impure expression (`new Array(0)`) into the
      // field initialiser *and* leaving the original store behind dead.
      // Only the constructor ever has an install to claim into, and a
      // constructor writes each of its own temporaries once before moving
      // on to the next field (`AddOwnPrivateBySym`'s own bytecode shape,
      // one per field) -- a register this rung tracks here is never read
      // again after the claim, in every fixture shape this rung sees.
      nextRegs = new Map(regs).set(store.name, resolve(regs, store.value));
      regSources.set(store.name, s);
    }

    const assignTarget = s.k === "expr" && s.expr.k === "assign" && store !== null ? s.expr.target : null;
    if (s.k === "expr") {
      if (allowInstall) {
        const defineArgs = objectCall(s.expr, "defineProperty");
        if (defineArgs !== null && defineArgs.length === 3 && isIdent(defineArgs[1]!) && aliases.has((defineArgs[1] as Ident).name) && isThisArg(defineArgs[0]!, regs) && privateInstallValue(defineArgs) !== null) {
          processExpr(s.expr, aliases, regs, assignTarget); // records initExpr/installs, consumes the key
          return { stmt: null, aliasesOut: nextAliases, regsOut: nextRegs };
        }
      }
      const expr = processExpr(s.expr, aliases, regs, assignTarget);
      return { stmt: expr === s.expr ? s : { ...s, expr }, aliasesOut: nextAliases, regsOut: nextRegs };
    }
    if (s.k === "init") {
      const value = processExpr(s.value, aliases, regs, null);
      return { stmt: value === s.value ? s : { ...s, value }, aliasesOut: nextAliases, regsOut: nextRegs };
    }
    if (s.k === "return") {
      const arg = s.arg === null ? null : processExpr(s.arg, aliases, regs, null);
      return { stmt: arg === s.arg ? s : { ...s, arg }, aliasesOut: nextAliases, regsOut: nextRegs };
    }
    if (s.k === "throw") {
      const arg = processExpr(s.arg, aliases, regs, null);
      return { stmt: arg === s.arg ? s : { ...s, arg }, aliasesOut: nextAliases, regsOut: nextRegs };
    }
    // Anything else this fixture's shapes never produce here (`decl`,
    // `break`/`continue`, a nested `func`, ...): no expression of its own to
    // scan (a `func`'s own body is a separate frame, out of reach of a
    // register name in any case).
    return { stmt: s, aliasesOut: nextAliases, regsOut: nextRegs };
  }

  function fold(stmts: readonly Stmt[], aliasesIn: ReadonlySet<string>, regsIn: ReadonlyMap<string, Expr>): { readonly stmts: readonly Stmt[]; readonly aliasesOut: ReadonlySet<string>; readonly regsOut: ReadonlyMap<string, Expr> } {
    let aliases = aliasesIn;
    let regs = regsIn;
    const out: Stmt[] = [];
    for (const s of stmts) {
      if (s.k === "labeled") {
        const inner = fold(s.body, aliases, regs);
        aliases = inner.aliasesOut;
        regs = inner.regsOut;
        out.push({ ...s, body: inner.stmts });
        continue;
      }
      if (s.k === "if") {
        const test = processExpr(s.test, aliases, regs, null);
        const thenOut = fold(s.then, aliases, regs);
        const elseOut = fold(s.else, aliases, regs);
        out.push(test === s.test && thenOut.stmts === s.then && elseOut.stmts === s.else ? s : { ...s, test, then: thenOut.stmts, else: elseOut.stmts });
        continue; // branches fork; neither's aliasing survives the `if`
      }
      const { stmt, aliasesOut, regsOut } = step(s, aliases, regs);
      aliases = aliasesOut;
      regs = regsOut;
      if (stmt !== null) out.push(stmt);
    }
    return { stmts: out, aliasesOut: aliases, regsOut: regs };
  }

  const result = fold(body, new Set([envName]), new Map());
  if (escaped || installs > 1) return null;
  const folded = claimedSources.size === 0 ? result.stmts : result.stmts.filter((s) => !claimedSources.has(s));
  const finalBody = redeclare(folded, droppedInits);
  return { body: finalBody, initExpr };
}

/** Re-declare every name whose `k:"init"` declaration this fold dropped and
 *  which some surviving statement still reads or writes. One `let` prologue,
 *  placed after any leading directive/comment (a `"use strict"` directive
 *  must stay first) -- the same shape and position the emitter's own register
 *  prologue uses, so `pruneRegisterDecls`/`hoistRegisterInits` can still
 *  recognise it. */
function redeclare(body: readonly Stmt[], droppedInits: readonly string[]): readonly Stmt[] {
  const names = [...new Set(droppedInits)].filter((n) => {
    const u = identUses(body, n);
    return u.reads + u.writes > 0;
  });
  if (names.length === 0) return body;
  let at = 0;
  while (at < body.length && (body[at]!.k === "comment" || body[at]!.k === "directive")) at++;
  return [...body.slice(0, at), { k: "decl", kind: "let", names }, ...body.slice(at)];
}

/** Folds one candidate across the whole function tree: the constructor (the
 *  only place an install may occur) and every other member's body. Returns
 *  the new tree, or `null` (refuse this one name; `before` is untouched). */
function foldOne(before: readonly Stmt[], envName: string, displayName: string): readonly Stmt[] | null {
  const cls = findClass(before);
  if (cls === null) return null;
  const ctor = ctorBody(cls);
  if (ctor === null) return null;

  const ctorOut = foldInBody(ctor, envName, displayName, true);
  if (ctorOut === null || ctorOut.initExpr === null) return null;

  let ok = true;
  const newMembers = cls.members.map((m) => {
    if (m.value === null || m.value.k !== "func") return m;
    const isCtor = m.kind === "method" && !m.static && m.key.k === "ident" && m.key.name === "constructor";
    if (isCtor) return { ...m, value: { ...m.value, body: ctorOut.body } };
    const out = foldInBody(m.value.body, envName, displayName, false);
    if (out === null) {
      ok = false;
      return m;
    }
    return { ...m, value: { ...m.value, body: out.body } };
  });
  if (!ok) return null;

  const field = { kind: "field" as const, static: false, computed: false, key: { k: "lit" as const, text: displayName }, value: ctorOut.initExpr.k === "ident" && ctorOut.initExpr.name === "undefined" ? null : ctorOut.initExpr };
  const newCls: ClassExpr = { ...cls, members: [field, ...newMembers] };

  const fx = (e: Expr): Expr => (e === cls ? newCls : e);
  const withoutDecl = before.filter((s) => {
    const store = simpleStore(s);
    return !(store !== null && store.name === envName && privateSymbolName(store.value) !== null);
  });
  const trimmed = withoutDecl.map((s) => (s.k === "decl" ? { ...s, names: s.names.filter((n) => n !== envName) } : s)).filter((s) => !(s.k === "decl" && s.names.length === 0));
  return mapStmts(trimmed, (s) => s, fx);
}

export function foldAll(before: readonly Stmt[]): { readonly after: readonly Stmt[]; readonly folded: readonly string[] } {
  let tree = before;
  const folded: string[] = [];
  for (const c of findCandidates(before)) {
    const next = foldOne(tree, c.envName, c.displayName);
    if (next !== null) {
      tree = next;
      folded.push(c.displayName);
    }
  }
  return { after: tree, folded };
}

export function match(before: readonly Stmt[], ctx: PassContext): Match<readonly Stmt[], PrivateFieldsGroup> | null {
  const { folded } = foldAll(before);
  if (folded.length === 0) return null;
  return { root: before, nodes: [before], data: { folded }, at: { functionIndex: ctx.functionIndex, offset: 0 } };
}
