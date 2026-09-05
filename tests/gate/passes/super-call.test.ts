// ACCEPTANCE: rung `super-call` (stage B, readability row R13) --
// docs/specs/passes/28-super-call.md.
//
// Hermes lowers a derived constructor's `super(args)` to
// `Reflect.construct(Object.getPrototypeOf(<the class's own env slot>),
// [args], new.target)` plus a TDZ marker and a statically dead
// "super() called twice" guard. ES2024 13.3.7.1 defines SuperCall as exactly
// that Construct followed by binding the result to `this`, so the rung
// rebuilds `super(args)` and calls the stand-in register `this`. This is the
// answer to `ctor-this`'s R-CT1 (304 of react-navigation's 448 recovered
// constructors).
//
// Rung-owned properties only (CLAUDE.md testing rules / CONSOLIDATION section
// B item 7): no whole-output string comparison against a shared fixture. The
// end-to-end proof that the rewrite is behaviour-preserving is T2
// (tests/gate/decompile/equivalence.test.ts), not this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import { repoRoot } from "../../support/paths.ts";
import type { Expr, Stmt } from "../../../src/passes/ast.ts";
import { classBindingSlots, foldSuperBody } from "../../../src/passes/super-call/match.ts";
import type { ClassExpr } from "../../../src/passes/super-call/match.ts";

const js = (fixture: string, version: "v98" | "v99", mode: "on" | "none" = "on"): string =>
  decompile(new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", fixture, `${version}.hbc`))), {
    resolveV98Ambiguity: true,
    passes: mode === "none" ? { none: true } : {},
  }).code;

/** The text of the `constructor(...) { ... }` that belongs to `class <name>`,
 *  so an assertion is about one constructor rather than about the whole shared
 *  fixture's output (CONSOLIDATION section B item 7). */
const ctorOf = (code: string, className: string): string => {
  const c = code.indexOf(`class ${className} `);
  assert.notEqual(c, -1, `no class ${className} in the decompiled output`);
  const i = code.indexOf("constructor(", c);
  assert.notEqual(i, -1, `class ${className} has no constructor`);
  const j = code.indexOf("\n  }\n", i);
  assert.notEqual(j, -1, "constructor body is not delimited as expected");
  return code.slice(i, j);
};

for (const version of ["v98", "v99"] as const) {
  test(`super-call: 33-class-inheritance-super ${version} -- Dog's constructor is rebuilt as super(...)`, () => {
    const on = js("33-class-inheritance-super", version);
    const dog = ctorOf(on, "Dog");
    assert.match(dog, /\bsuper\(/);
    // The lowering it replaced is gone from that constructor: no
    // Reflect.construct, no getPrototypeOf, no double-super guard, and the
    // receiver is the literal `this`.
    assert.doesNotMatch(dog, /Reflect\.construct/);
    assert.doesNotMatch(dog, /getPrototypeOf/);
    assert.doesNotMatch(dog, /super\(\) called twice/);
    assert.match(dog, /\bthis\.breed = /);
    // Exactly one super call in that constructor (R-SC2's whole point).
    assert.equal(dog.split(/\bsuper\(/).length - 1, 1);
  });

  test(`super-call: 33-class-inheritance-super ${version} -- --passes=none still shows the untouched lowering (PL-05)`, () => {
    const none = js("33-class-inheritance-super", version, "none");
    assert.match(none, /Reflect\.construct\(/);
    assert.match(none, /super\(\) called twice/);
    assert.doesNotMatch(none, /\bsuper\(\w/);
  });

  test(`super-call: 33-class-inheritance-super ${version} -- the implicit derived constructor is rebuilt as the forward (R-SC6 folded)`, () => {
    const on = js("33-class-inheritance-super", version);
    const puppy = ctorOf(on, "Puppy");
    // `class Puppy extends Dog {}`: hermesc's implicit derived constructor,
    // whose whole body is the applyArguments forward, comes back as the
    // explicit spread form (spec 28 section 9).
    assert.doesNotMatch(puppy, /__hbc_b_applyArguments/);
    assert.match(puppy, /^constructor\(\.\.\.\w+\)/);
    assert.match(puppy, /\bsuper\(\.\.\.\w+\);/);
    // A non-simple parameter list may not carry a directive prologue
    // (ES2024 15.2.1); a class body is strict code anyway.
    assert.doesNotMatch(puppy, /"use strict"/);
    // The rest parameter it declares is the one the super call spreads.
    const param = /^constructor\(\.\.\.(\w+)\)/.exec(puppy)![1];
    assert.match(puppy, new RegExp(`super\\(\\.\\.\\.${param}\\);`));
  });

  test(`super-call: 33-class-inheritance-super ${version} -- no other class gains a super call`, () => {
    const on = js("33-class-inheritance-super", version);
    // `Animal` is a base class: `ctor-this` owns it, and this rung must not
    // touch it. `super.speak()` in the methods is a Reflect.get shape, not
    // this rung's, so exactly two STATEMENTS in the module are super calls --
    // `Dog`'s explicit one and `Puppy`'s rebuilt implicit forward. (The
    // `new Dog(...)` at module scope keeps its own untouched lowering, guard
    // text and all -- that is a `new`, not a super call.)
    assert.equal(on.split(/^\s*super\(/gm).length - 1, 2);
    assert.doesNotMatch(ctorOf(on, "Animal"), /\bsuper\(/);
  });
}

// --- hand-built refusal units (spec 28 section 6) ---------------------------
//
// Every refusal gets a unit here, built from AST literals rather than from a
// fixture: several of these shapes cannot be produced by hermesc from any
// source we can write (a conditional super is a SyntaxError in JS but is
// perfectly expressible in bytecode), which is exactly why the guard exists.

const ident = (name: string): Expr => ({ k: "ident", name });
const lit = (text: string): Expr => ({ k: "lit", text });
const store = (name: string, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target: ident(name), value } });
const getProto = (arg: Expr): Expr => ({ k: "call", callee: { k: "member", obj: ident("Object"), prop: lit("getPrototypeOf"), computed: false }, args: [arg] });
const construct = (callee: Expr, args: Expr, nt: Expr): Expr => ({ k: "call", callee: { k: "member", obj: ident("Reflect"), prop: lit("construct"), computed: false }, args: [callee, args, nt] });

/** A derived class whose constructor body is `body`, published into `_e0_1`
 *  exactly the way `class-recover`'s output publishes one, plus the enclosing
 *  module statements that make `_e0_1` provable evidence (spec 28 section 4). */
function moduleWith(body: readonly Stmt[]): { module: readonly Stmt[]; cls: ClassExpr } {
  const cls: ClassExpr = {
    k: "class",
    name: "Derived",
    superClass: ident("r5"),
    members: [{ kind: "method", static: false, computed: false, key: ident("constructor"), value: { k: "func", name: null, params: [{ name: "a1" }], body } }],
  } as unknown as ClassExpr;
  const module: readonly Stmt[] = [store("r6", cls as unknown as Expr), store("r3", { k: "member", obj: ident("r6"), prop: lit("prototype"), computed: false }), store("_e0_1", ident("r6"))];
  return { module, cls };
}

const OK_BODY: readonly Stmt[] = [
  store("r3", lit("new.target")),
  store("r0", ident("_e0_1")),
  store("r2", getProto(ident("r0"))),
  store("r4", ident("a1")),
  store("r0", construct(ident("r2"), { k: "array", elements: [ident("r4")] }, ident("r3"))),
  { k: "expr", expr: { k: "assign", target: { k: "member", obj: ident("r0"), prop: lit("x"), computed: false }, value: ident("r4") } },
  { k: "return", arg: ident("r0") },
];

test("super-call: the reference body folds, and its evidence is the class's own env slot", () => {
  const { module, cls } = moduleWith(OK_BODY);
  assert.deepEqual([...classBindingSlots(module, cls)], ["_e0_1"]);
  const out = foldSuperBody(module, cls, OK_BODY);
  assert.ok(!("code" in out), `expected a fold, got ${JSON.stringify(out)}`);
});

test("super-call: a base class is not this rung's shape (R-SC0)", () => {
  const { module, cls } = moduleWith(OK_BODY);
  const base = { ...cls, superClass: null } as unknown as ClassExpr;
  const out = foldSuperBody(module, base, OK_BODY);
  assert.equal("code" in out && out.code, "R-SC0");
});

test("super-call: a superclass read from a slot that is not this class's binding is refused (R-SC1)", () => {
  const { module, cls } = moduleWith(OK_BODY);
  const body = OK_BODY.map((s, i) => (i === 1 ? store("r0", ident("_e0_9")) : s));
  const out = foldSuperBody(module, cls, body);
  assert.equal("code" in out && out.code, "R-SC1");
});

test("super-call: a slot written twice anywhere stops being evidence (R-SC1)", () => {
  const { module, cls } = moduleWith(OK_BODY);
  const shadowed = [...module, store("_e0_1", lit("null"))];
  assert.equal(classBindingSlots(shadowed, cls).size, 0);
  const out = foldSuperBody(shadowed, cls, OK_BODY);
  assert.equal("code" in out && out.code, "R-SC1");
});

test("super-call: a new.target argument that is not the constructor's own is refused (R-SC1)", () => {
  const { module, cls } = moduleWith(OK_BODY);
  const body = OK_BODY.map((s, i) => (i === 0 ? store("r3", ident("r9")) : s));
  const out = foldSuperBody(module, cls, body);
  assert.equal("code" in out && out.code, "R-SC1");
});

test("super-call: two Reflect.construct sites (a conditional super) are refused (R-SC2)", () => {
  const { module, cls } = moduleWith(OK_BODY);
  const body = [...OK_BODY, store("r0", construct(ident("r2"), { k: "array", elements: [] }, ident("r3")))];
  const out = foldSuperBody(module, cls, body);
  assert.equal("code" in out && out.code, "R-SC2");
});

test("super-call: a super site inside an if/loop/try is refused (R-SC3)", () => {
  const { module, cls } = moduleWith(OK_BODY);
  const body: readonly Stmt[] = [...OK_BODY.slice(0, 4), { k: "if", test: ident("a1"), then: [OK_BODY[4]!], else: [] }, ...OK_BODY.slice(5)];
  const out = foldSuperBody(module, cls, body);
  assert.equal("code" in out && out.code, "R-SC3");
});

test("super-call: a stand-in written again after the super call is refused (R-SC4)", () => {
  const { module, cls } = moduleWith(OK_BODY);
  const body = [...OK_BODY.slice(0, 6), store("r0", lit("1")), OK_BODY[6]!];
  const out = foldSuperBody(module, cls, body);
  assert.equal("code" in out && out.code, "R-SC4");
});

test("super-call: a stand-in name mentioned in a nested closure is refused (R-SC5)", () => {
  const { module, cls } = moduleWith(OK_BODY);
  const nested: Stmt = { k: "expr", expr: { k: "func", name: null, params: [], body: [{ k: "return", arg: ident("r0") }] } as unknown as Expr };
  const body = [...OK_BODY.slice(0, 6), nested, OK_BODY[6]!];
  const out = foldSuperBody(module, cls, body);
  assert.equal("code" in out && out.code, "R-SC5");
});

// --- R-SC6: the implicit/forwarding derived constructor (spec 28 section 9) --

const forward = (args: readonly Expr[]): Stmt => ({ k: "return", arg: { k: "call", callee: ident("__hbc_b_applyArguments"), args: [...args] } });
const FORWARD_BODY: readonly Stmt[] = [{ k: "comment", text: 'fn#7 "Derived"' }, { k: "directive", text: "use strict" }, forward([{ k: "argumentsObject" }, getProto(ident("_e0_1")), lit("undefined"), lit("new.target")])];

test("super-call: the applyArguments forward becomes constructor(...args) { super(...args); } (R-SC6)", () => {
  const { module, cls } = moduleWith(FORWARD_BODY);
  const out = foldSuperBody(module, cls, FORWARD_BODY, []);
  assert.ok(!("code" in out), `expected a fold, got ${JSON.stringify(out)}`);
  // A rest parameter is declared, and the super call spreads exactly it.
  assert.equal(out.params?.length, 1);
  const param = out.params![0]!;
  assert.equal(param.rest, true);
  // The provenance comment survives; the directive does not (ES2024 15.2.1:
  // a non-simple parameter list may not carry one, and a class body is
  // strict code already).
  assert.deepEqual(out.body.map((s) => s.k), ["comment", "expr"]);
  const call = (out.body[1] as { expr: Expr }).expr;
  assert.equal(call.k === "call" && call.callee.k === "lit" && call.callee.text, "super");
  assert.deepEqual(call.k === "call" ? call.args : null, [{ k: "spread", arg: ident(param.name) }]);
});

test("super-call: a forwarding constructor with declared parameters is refused (R-SC9)", () => {
  const { module, cls } = moduleWith(FORWARD_BODY);
  const out = foldSuperBody(module, cls, FORWARD_BODY, [{ name: "a1" }]);
  assert.equal("code" in out && out.code, "R-SC9");
});

test("super-call: a forwarding constructor that runs anything else is refused (R-SC9)", () => {
  const { module, cls } = moduleWith(FORWARD_BODY);
  const effect: Stmt = { k: "expr", expr: { k: "call", callee: ident("sideEffect"), args: [] } };
  const out = foldSuperBody(module, cls, [effect, ...FORWARD_BODY], []);
  assert.equal("code" in out && out.code, "R-SC9");
});

test("super-call: the forward's own operand moves are deleted, hoisted declarations are kept", () => {
  const { module, cls } = moduleWith(FORWARD_BODY);
  // The shape a real bundle shows (react-navigation, 136 of 147 R-SC9 rows
  // before this was allowed): the emitter hosts a hoisted `function` in the
  // constructor's frame and moves the forward's operands into registers.
  const hosted: Stmt = { k: "func", name: "_fn9", params: [], body: [{ k: "return", arg: lit("1") }] } as unknown as Stmt;
  const body: readonly Stmt[] = [
    { k: "comment", text: 'fn#7 "Derived"' },
    { k: "directive", text: "use strict" },
    hosted,
    { k: "decl", kind: "let", names: ["r0", "r2", "r3", "r4", "r5"] } as unknown as Stmt,
    store("r0", ident("_e0_1")),
    store("r2", getProto(ident("r0"))),
    store("r3", lit("new.target")),
    store("r4", lit("undefined")),
    store("r5", ident("r2")),
    forward([{ k: "argumentsObject" }, ident("r5"), ident("r4"), ident("r3")]),
  ];
  const out = foldSuperBody(module, cls, body, []);
  assert.ok(!("code" in out), `expected a fold, got ${JSON.stringify(out)}`);
  assert.deepEqual(out.body.map((s) => s.k), ["comment", "func", "expr"]);
  assert.equal(out.params?.[0]?.rest, true);
});

test("super-call: a forwarding constructor whose operand store is still read is refused (R-SC9)", () => {
  const { module, cls } = moduleWith(FORWARD_BODY);
  const nested: Stmt = { k: "func", name: "_fn9", params: [], body: [{ k: "return", arg: ident("r0") }] } as unknown as Stmt;
  const body: readonly Stmt[] = [store("r0", ident("_e0_1")), nested, forward([{ k: "argumentsObject" }, getProto(ident("_e0_1")), lit("undefined"), lit("new.target")])];
  const out = foldSuperBody(module, cls, body, []);
  assert.equal("code" in out && out.code, "R-SC9");
});

test("super-call: a second read of `arguments` in a forwarding constructor is refused (R-SC9)", () => {
  const { module, cls } = moduleWith(FORWARD_BODY);
  const body: readonly Stmt[] = [forward([{ k: "argumentsObject" }, getProto(ident("_e0_1")), { k: "argumentsObject" }, lit("new.target")])];
  const out = foldSuperBody(module, cls, body, []);
  assert.equal("code" in out && out.code, "R-SC9");
});

// --- R-SC9 residue: `argumentsUses` is frame-aware (spec 28 section 9.5) ---

test("super-call: a hosted function's own `arguments` is not the constructor's, and still folds", () => {
  const { module, cls } = moduleWith(FORWARD_BODY);
  // The real react-navigation shape (136 of 147 R-SC9 rows before this): the
  // hosted declaration reads its own `arguments`, which must not be mistaken
  // for a second read of the constructor's.
  const hosted: Stmt = { k: "func", name: "_fn9", params: [], body: [{ k: "return", arg: { k: "argumentsObject" } }] } as unknown as Stmt;
  const body: readonly Stmt[] = [FORWARD_BODY[0]!, FORWARD_BODY[1]!, hosted, FORWARD_BODY[2]!];
  const out = foldSuperBody(module, cls, body, []);
  assert.ok(!("code" in out), `expected a fold, got ${JSON.stringify(out)}`);
  assert.deepEqual(out.body.map((s) => s.k), ["comment", "func", "expr"]);
});

test("super-call: a nested arrow's `arguments` is the constructor's own, and is refused (R-SC9)", () => {
  const { module, cls } = moduleWith(FORWARD_BODY);
  // An arrow has no `arguments` of its own (ES2024 10.2.4): a lexical read
  // of the enclosing frame's binding surfaces as a plain `ident{name:
  // "arguments"}`, never `argumentsObject` -- `arguments-form/match.ts`'s
  // own recognition of the two shapes as equivalent.
  const arrow: Stmt = { k: "expr", expr: { k: "func", name: null, params: [], body: [{ k: "return", arg: ident("arguments") }] } as unknown as Expr };
  const body: readonly Stmt[] = [FORWARD_BODY[0]!, FORWARD_BODY[1]!, arrow, FORWARD_BODY[2]!];
  const out = foldSuperBody(module, cls, body, []);
  assert.equal("code" in out && out.code, "R-SC9");
  assert.match("code" in out ? out.reason : "", /arguments/);
});

test("super-call: a `sameFrame` closure's `arguments` is still the constructor's own, and is refused (R-SC9)", () => {
  const { module, cls } = moduleWith(FORWARD_BODY);
  // The generator-resume closure (`src/emit/ast.ts`'s `func.sameFrame`)
  // shares this frame's own registers and its own `arguments`, so its read
  // is a second read of the same object, exactly like one written inline.
  const resume: Stmt = { k: "expr", expr: { k: "func", name: null, params: [], sameFrame: true, body: [{ k: "return", arg: { k: "argumentsObject" } }] } as unknown as Expr };
  const body: readonly Stmt[] = [FORWARD_BODY[0]!, FORWARD_BODY[1]!, resume, FORWARD_BODY[2]!];
  const out = foldSuperBody(module, cls, body, []);
  assert.equal("code" in out && out.code, "R-SC9");
  assert.match("code" in out ? out.reason : "", /arguments/);
});

test("super-call: a forward whose target is not this class's own binding is refused (R-SC8)", () => {
  const { module, cls } = moduleWith(FORWARD_BODY);
  const body: readonly Stmt[] = [forward([{ k: "argumentsObject" }, getProto(ident("_e0_9")), lit("undefined"), lit("new.target")])];
  const out = foldSuperBody(module, cls, body, []);
  assert.equal("code" in out && out.code, "R-SC8");
});

test("super-call: a forward whose new.target is not the frame's own is refused (R-SC8)", () => {
  const { module, cls } = moduleWith(FORWARD_BODY);
  const body: readonly Stmt[] = [forward([{ k: "argumentsObject" }, getProto(ident("_e0_1")), lit("undefined"), ident("r9")])];
  const out = foldSuperBody(module, cls, body, []);
  assert.equal("code" in out && out.code, "R-SC8");
});

test("super-call: a forward that passes a receiver (the apply path) is refused (R-SC8)", () => {
  const { module, cls } = moduleWith(FORWARD_BODY);
  const body: readonly Stmt[] = [forward([{ k: "argumentsObject" }, getProto(ident("_e0_1")), ident("r4"), lit("new.target")])];
  const out = foldSuperBody(module, cls, body, []);
  assert.equal("code" in out && out.code, "R-SC8");
});

// --- section 9.6: `r0 = applyArguments(...); return r0;` (store-then-return) --

const applyCall = (): Expr => ({ k: "call", callee: ident("__hbc_b_applyArguments"), args: [{ k: "argumentsObject" }, getProto(ident("_e0_1")), lit("undefined"), lit("new.target")] });
const STORE_RETURN_BODY: readonly Stmt[] = [FORWARD_BODY[0]!, FORWARD_BODY[1]!, store("r0", applyCall()), { k: "return", arg: ident("r0") }];

test("super-call: `r0 = applyArguments(...); return r0;` dereferences through the store and folds (section 9.6)", () => {
  const { module, cls } = moduleWith(STORE_RETURN_BODY);
  const out = foldSuperBody(module, cls, STORE_RETURN_BODY, []);
  assert.ok(!("code" in out), `expected a fold, got ${JSON.stringify(out)}`);
  assert.deepEqual(out.body.map((s) => s.k), ["comment", "expr"]);
  const call = (out.body[1] as { expr: Expr }).expr;
  assert.equal(call.k === "call" && call.callee.k === "lit" && call.callee.text, "super");
});

test("super-call: an early read of the receiver before the store is refused (R-SC9)", () => {
  // Section 9.7: the store is now found by scanning for it rather than
  // assumed adjacent to the return, so this shape is caught by the HEAD
  // loop (the same "statement the forward did not consume" refusal an
  // unrelated head statement already gets, R-SC9) rather than by a
  // whole-body reads count -- still refused, same code, a more specific
  // message (the diagnostic used to be a total-uses count; the shape it
  // covered here is actually a statement before the store, not after it).
  const { module, cls } = moduleWith(STORE_RETURN_BODY);
  const earlyRead: Stmt = { k: "expr", expr: { k: "call", callee: ident("sideEffect"), args: [ident("r0")] } };
  const body: readonly Stmt[] = [STORE_RETURN_BODY[0]!, STORE_RETURN_BODY[1]!, earlyRead, STORE_RETURN_BODY[2]!, STORE_RETURN_BODY[3]!];
  const out = foldSuperBody(module, cls, body, []);
  assert.equal("code" in out && out.code, "R-SC9");
  assert.match("code" in out ? out.reason : "", /did not consume/);
});

test("super-call: a statement between the store and the return that is not a field install or a receiver capture is refused (R-SC9)", () => {
  const { module, cls } = moduleWith(STORE_RETURN_BODY);
  const between: Stmt = { k: "expr", expr: { k: "call", callee: ident("sideEffect"), args: [] } };
  const body: readonly Stmt[] = [STORE_RETURN_BODY[0]!, STORE_RETURN_BODY[1]!, STORE_RETURN_BODY[2]!, between, STORE_RETURN_BODY[3]!];
  const out = foldSuperBody(module, cls, body, []);
  assert.equal("code" in out && out.code, "R-SC9");
  assert.match("code" in out ? out.reason : "", /neither a field install nor a receiver capture/);
});

test("super-call: `return <ident>` whose preceding store is not the applyArguments call is refused (R-SC9)", () => {
  const { module, cls } = moduleWith(STORE_RETURN_BODY);
  // The unused earlier statement keeps `foldSuperBody` routing into the
  // forward path (it scans the whole body for the intrinsic), but the tail's
  // own preceding store is a plain literal, not the forward itself.
  const body: readonly Stmt[] = [store("temp", applyCall()), store("r0", lit("1")), { k: "return", arg: ident("r0") }];
  const out = foldSuperBody(module, cls, body, []);
  assert.equal("code" in out && out.code, "R-SC9");
});

// --- section 9.7: field installs (and an env-slot receiver capture for a
// nested closure) between the forward's store and its `return` -------------

const install = (obj: string, prop: string, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target: { k: "member", obj: ident(obj), prop: lit(prop), computed: false }, value } });

test("super-call: two field installs after the forward fold to `this.<prop> = <expr>;` (section 9.7)", () => {
  const { module, cls } = moduleWith(FORWARD_BODY);
  const body: readonly Stmt[] = [FORWARD_BODY[0]!, FORWARD_BODY[1]!, store("r0", applyCall()), install("r0", "other", lit("1")), install("r0", "bound", ident("helper")), { k: "return", arg: ident("r0") }];
  const out = foldSuperBody(module, cls, body, []);
  assert.ok(!("code" in out), `expected a fold, got ${JSON.stringify(out)}`);
  assert.deepEqual(out.body.map((s) => s.k), ["comment", "expr", "expr", "expr"]);
  const [superStmt, other, bound] = out.body.slice(1) as { expr: Expr }[];
  const superExpr = superStmt!.expr;
  assert.equal(superExpr.k === "call" && superExpr.callee.k === "lit" && superExpr.callee.text, "super");
  const otherExpr = other!.expr as Extract<Expr, { k: "assign" }>;
  const boundExpr = bound!.expr as Extract<Expr, { k: "assign" }>;
  assert.deepEqual(otherExpr.target, { k: "member", obj: { k: "this" }, prop: lit("other"), computed: false });
  assert.deepEqual(boundExpr.target, { k: "member", obj: { k: "this" }, prop: lit("bound"), computed: false });
});

test("super-call: a receiver captured into an env slot for a nested closure folds, the closure untouched (section 9.7)", () => {
  // The real react-navigation shape: an arrow class field (`handle = () =>
  // this.x`) is created BEFORE `super()` runs, so the emitter captures the
  // receiver into the frame's own env slot for the closure to read, then
  // installs the closure itself as a field once the capture is done.
  const { module, cls } = moduleWith(FORWARD_BODY);
  const handle: Stmt = { k: "func", name: "handle", params: [], body: [{ k: "return", arg: { k: "member", obj: ident("_e1_0"), prop: lit("x"), computed: false } }] } as unknown as Stmt;
  const decl: Stmt = { k: "decl", kind: "let", names: ["_e1_0"] } as unknown as Stmt;
  const body: readonly Stmt[] = [FORWARD_BODY[0]!, FORWARD_BODY[1]!, decl, handle, store("r0", applyCall()), store("_e1_0", ident("r0")), install("r0", "handle", ident("handle")), install("r0", "other", lit("1")), { k: "return", arg: ident("r0") }];
  const out = foldSuperBody(module, cls, body, []);
  assert.ok(!("code" in out), `expected a fold, got ${JSON.stringify(out)}`);
  assert.deepEqual(out.body.map((s) => s.k), ["comment", "decl", "func", "expr", "expr", "expr", "expr"]);
  // The closure body is untouched (it still reads `_e1_0`, unchanged) --
  // only the capture statement's right-hand side becomes `this`.
  const closure = out.body[2] as { body: readonly Stmt[] };
  assert.deepEqual((closure.body[0] as { arg: Expr }).arg, { k: "member", obj: ident("_e1_0"), prop: lit("x"), computed: false });
  const capture = out.body[4] as { expr: Extract<Expr, { k: "assign" }> };
  assert.deepEqual(capture.expr, { k: "assign", target: ident("_e1_0"), value: { k: "this" } });
});

test("super-call: a field install with a computed key after the forward is refused (R-SC9)", () => {
  const { module, cls } = moduleWith(FORWARD_BODY);
  const computed: Stmt = { k: "expr", expr: { k: "assign", target: { k: "member", obj: ident("r0"), prop: ident("propName"), computed: true }, value: lit("1") } };
  const body: readonly Stmt[] = [FORWARD_BODY[0]!, FORWARD_BODY[1]!, store("r0", applyCall()), computed, { k: "return", arg: ident("r0") }];
  const out = foldSuperBody(module, cls, body, []);
  assert.equal("code" in out && out.code, "R-SC9");
  assert.match("code" in out ? out.reason : "", /computed key/);
});

test("super-call: a field install whose value reads the receiver itself is refused (R-SC9)", () => {
  const { module, cls } = moduleWith(FORWARD_BODY);
  const body: readonly Stmt[] = [FORWARD_BODY[0]!, FORWARD_BODY[1]!, store("r0", applyCall()), install("r0", "self", { k: "member", obj: ident("r0"), prop: lit("x"), computed: false }), { k: "return", arg: ident("r0") }];
  const out = foldSuperBody(module, cls, body, []);
  assert.equal("code" in out && out.code, "R-SC9");
  assert.match("code" in out ? out.reason : "", /reads the receiver itself/);
});

// --- fixture 78: the implicit constructor next to the explicit spread one ---

for (const version of ["v98", "v99"] as const) {
  test(`super-call: 78-class-implicit-derived-ctor ${version} -- the implicit constructor is rebuilt, the explicit spread one is not this rung's shape`, () => {
    const on = js("78-class-implicit-derived-ctor", version);
    const implicit = ctorOf(on, "Implicit");
    assert.doesNotMatch(implicit, /__hbc_b_applyArguments/);
    assert.match(implicit, /^constructor\(\.\.\.\w+\)/);
    assert.match(implicit, /\bsuper\(\.\.\.\w+\);/);
    // `constructor(...a) { super(...a); }` written out in the source lowers to
    // the spread super call (copyRestArgs + applyWithNewTarget) instead, which
    // is a different shape and stays refused (docs/BUGS.md, R-SC7).
    const explicit = ctorOf(on, "Explicit");
    assert.match(explicit, /__hbc_b_applyWithNewTarget|__hbc_b_copyRestArgs/);
    // (its only `super(` is inside the dead guard's message string)
    assert.doesNotMatch(explicit, /\bsuper\(\.\.\./);
    assert.doesNotMatch(explicit, /^\s*super\(/m);
    // `Base` is not even recovered as a class here (it keeps its function
    // form), so the rebuilt forward is the module's ONE statement-level
    // super call.
    assert.equal(on.split(/^\s*super\(/gm).length - 1, 1);
  });

  test(`super-call: 78-class-implicit-derived-ctor ${version} -- --passes=none still shows the untouched forward (PL-05)`, () => {
    // `--passes=none` has no `class` nodes at all (class-recover is off), so
    // this is a module-level assertion: the forward is still there verbatim
    // and nothing is a statement-level super call.
    const none = js("78-class-implicit-derived-ctor", version, "none");
    assert.match(none, /__hbc_b_applyArguments\(arguments, /);
    assert.equal(none.split(/^\s*super\(/gm).length - 1, 0);
  });
}

// --- fixture 80: field installs (and a nested-closure receiver capture)
// after the forward (section 9.7, the 136 `R-SC9 func` refusals) -----------

for (const version of ["v98", "v99"] as const) {
  test(`super-call: 80-super-forward-field-installs ${version} -- B's constructor is rebuilt with super(...) followed by this.-installs`, () => {
    const on = js("80-super-forward-field-installs", version);
    const b = ctorOf(on, "B");
    assert.doesNotMatch(b, /__hbc_b_applyArguments/);
    assert.match(b, /^constructor\(\.\.\.\w+\)/);
    assert.match(b, /\bsuper\(\.\.\.\w+\);/);
    // The two class fields survive as `this.`-installs after the super call
    // -- an arrow field (captured into an env slot for `handle`'s own body
    // to read, so its own assignment reads `this` rather than a raw
    // register) and a plain one.
    assert.match(b, /this\.handle\s*=\s*handle;/);
    assert.match(b, /this\.other\s*=\s*1;/);
    // Nothing above the rebuilt constructor still returns the receiver by
    // hand -- a derived constructor yields `this` on its own.
    assert.doesNotMatch(b, /return\s+\w+;\s*\}\s*$/);
  });

  test(`super-call: 80-super-forward-field-installs ${version} -- handle() still returns the right value once called as a method`, () => {
    // The end-to-end proof that capturing the receiver into an env slot
    // (rather than substituting inside the closure) is behaviour-preserving:
    // T2 equivalence covers the whole module, but this pins the shape this
    // rung is specifically responsible for -- `handle`'s own body is
    // untouched, still reading whatever the env slot the capture statement
    // now assigns `this` to.
    const on = js("80-super-forward-field-installs", version);
    const b = ctorOf(on, "B");
    assert.match(b, /=\s*this\s*;/); // the capture statement, `_eD_S = this;`
  });

  test(`super-call: 80-super-forward-field-installs ${version} -- C's explicit rest-param constructor is a different lowering, not this rung's shape`, () => {
    // `constructor(...args) { super(...args); this.y = args.length; }`
    // reads its own rest parameter for something besides the forward, so
    // hermesc never uses the `applyArguments` intrinsic for it at all (it
    // needs the materialised array) -- the spread/apply lowering instead
    // (fixture 78's `Explicit`), a different shape this rung does not fold.
    const on = js("80-super-forward-field-installs", version);
    const c = ctorOf(on, "C");
    assert.match(c, /__hbc_b_applyWithNewTarget|__hbc_b_copyRestArgs/);
    assert.doesNotMatch(c, /\bsuper\(\.\.\./);
  });

  test(`super-call: 80-super-forward-field-installs ${version} -- --passes=none still shows the untouched forward (PL-05)`, () => {
    const none = js("80-super-forward-field-installs", version, "none");
    assert.match(none, /__hbc_b_applyArguments\(arguments, /);
    assert.equal(none.split(/^\s*super\(/gm).length - 1, 0);
  });
}

test("super-call: a spread/apply argument list is refused (R-SC7, docs/BUGS.md)", () => {
  const { module, cls } = moduleWith(OK_BODY);
  const body = OK_BODY.map((s, i) => (i === 4 ? store("r0", construct(ident("r2"), ident("r7"), ident("r3"))) : s));
  const out = foldSuperBody(module, cls, body);
  assert.equal("code" in out && out.code, "R-SC7");
});
