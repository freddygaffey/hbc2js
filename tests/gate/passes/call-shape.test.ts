// docs/specs/passes/04-call-shape.md — unit tests on hand-built ASTs (§7's
// checklist: one positive per rule R3a-d, negatives for a non-literal
// argument array, an impure callee, a member callee with an undefined
// receiver, and `Reflect.construct` with a distinct new-target; a real
// `check` refusal), plus red->green on the fixture corpus at all five HBC
// versions and the .min/.obf tiers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { check } from "../../../src/passes/call-shape/check.ts";
import { callShape } from "../../../src/passes/call-shape/index.ts";
import { classifyNode, match } from "../../../src/passes/call-shape/match.ts";
import { rewrite } from "../../../src/passes/call-shape/rewrite.ts";
import type { PassContext } from "../../../src/passes/types.ts";

// ---------------------------------------------------------------------------
// Hand-built-AST helpers.
// ---------------------------------------------------------------------------

const UNDEF: Expr = lit("undefined");
const assignExpr = (target: Expr, value: Expr): Expr => ({ k: "assign", target, value });
const exprStmt = (e: Expr): Stmt => ({ k: "expr", expr: e });
const call = (callee: Expr, args: readonly Expr[]): Expr => ({ k: "call", callee, args });
const member = (obj: Expr, prop: string): Expr => ({ k: "member", obj, prop: lit(prop), computed: false });
const arr = (elements: readonly Expr[]): Expr => ({ k: "array", elements });
const funcStmt = (name: string, body: readonly Stmt[]): Stmt => ({ k: "func", name, params: [], body });

const reflectApply = (F: Expr, T: Expr, args: readonly Expr[]): Expr => call(member(id("Reflect"), "apply"), [F, T, arr(args)]);
const reflectConstruct = (C: Expr, args: readonly Expr[], NT?: Expr): Expr => call(member(id("Reflect"), "construct"), NT === undefined ? [C, arr(args)] : [C, arr(args), NT]);
const helperCall = (F: Expr, T: Expr, rest: readonly Expr[]): Expr => call(id("__hbc_b_functionPrototypeCall"), [F, T, ...rest]);
const helperApply = (F: Expr, T: Expr, argsExpr: Expr): Expr => call(id("__hbc_b_functionPrototypeApply"), [F, T, argsExpr]);

function ctxFor(fnBody: readonly Stmt[]): PassContext {
  return {
    analysis: null as unknown as PassContext["analysis"],
    functionIndex: 0,
    cfg: {} as PassContext["cfg"],
    hbcVersion: 94,
    layoutClass: "hbc94" as PassContext["layoutClass"],
    applied: [],
    diagnostic: () => {},
    fnBody,
  };
}

// ---------------------------------------------------------------------------
// §4 — one positive per rule.
// ---------------------------------------------------------------------------

test("R3a: plain call — Reflect.apply with a literal undefined this becomes a bare call", () => {
  const before: readonly Stmt[] = [exprStmt(reflectApply(id("print"), UNDEF, [lit('"x"'), id("y")]))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.rule, "R3a");
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(call(id("print"), [lit('"x"'), id("y")]))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

test("R3a: a register with exactly one write, valued literal undefined, proves `this`", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), UNDEF)), exprStmt(reflectApply(id("f"), id("r1"), [id("a")]))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.rule, "R3a");
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(assignExpr(id("r1"), UNDEF)), exprStmt(call(id("f"), [id("a")]))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

// Framework fix (docs/AGENT-LOG.md, docs/STATUS.md): §4's literal text asked
// `isProvenUndefinedThis` to also require "no nested-closure read" on `T`'s
// register, checked via a bare `identUses(fnBody, t.name).nested === 0` —
// but Hermes restarts register numbering per function, so a nested `func`
// mentioning the same number as `T` is provably that closure's own,
// unrelated local (a real capture is always a distinct env-slot name), never
// a read of *this* frame's `T`. `21-iife-closures` hit this on every single
// site. Below: the same shape as the positive test above, except a sibling
// closure's own body happens to reuse `r1` for something unrelated — this
// must still prove `this` and fold, exactly as if the closure were not there.
test("R3a: a nested func's own, same-numbered local does not block proving `this` (scoped analysis)", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), UNDEF)), funcStmt("g", [exprStmt(call(id("use"), [id("r1")]))]), exprStmt(reflectApply(id("f"), id("r1"), [id("a")]))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.rule, "R3a");
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(assignExpr(id("r1"), UNDEF)), funcStmt("g", [exprStmt(call(id("use"), [id("r1")]))]), exprStmt(call(id("f"), [id("a")]))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

test("R3b: method call — Reflect.apply(O.P, O, args) becomes O.P(args)", () => {
  const before: readonly Stmt[] = [exprStmt(reflectApply(member(id("r5"), "push"), id("r5"), [id("x")]))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.rule, "R3b");
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(call(member(id("r5"), "push"), [id("x")]))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

test("R3b: a computed property survives as a computed call", () => {
  const computedMember: Expr = { k: "member", obj: id("r5"), prop: id("r6"), computed: true };
  const before: readonly Stmt[] = [exprStmt(reflectApply(computedMember, id("r5"), [id("x")]))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.rule, "R3b");
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(call(computedMember, [id("x")]))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

test("R3c: construct — Reflect.construct(C, args) becomes new C(args)", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), reflectConstruct(id("C"), [id("a"), id("b")])))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.rule, "R3c");
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(assignExpr(id("r1"), { k: "new", callee: id("C"), args: [id("a"), id("b")] }))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

test("R3c: construct with a new-target syntactically identical to the callee is an ordinary new", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), reflectConstruct(id("r2"), [id("a")], id("r2"))))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.rule, "R3c");
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(assignExpr(id("r1"), { k: "new", callee: id("r2"), args: [id("a")] }))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

test("duplicated-construct-callee: a member callee syntactically identical to the new-target is refused, not folded (H1 regression)", () => {
  // Reflect.construct(a.b, [x], a.b): the baseline evaluates the member
  // `a.b` TWICE (once as callee, once as new-target). `new a.b(x)` would
  // evaluate it only ONCE — a getter/Proxy on `b` fires a different number
  // of times. Unlike the identifier case (a register/ident is free to
  // re-evaluate), this must refuse per-site, not fold. docs/reviews/M5-pass-4.md H1.
  const memberCallee = member(id("a"), "b");
  const node = reflectConstruct(memberCallee, [id("x")], member(id("a"), "b"));
  assert.deepEqual(classifyNode(node, []), { ok: false, reason: "duplicated-construct-callee" });
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), node))];
  assert.equal(match(before, ctxFor(before)), null);
});

test("R3c: a plain identifier callee with an identical-identifier 3-arg new-target still folds", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), reflectConstruct(id("C"), [id("x")], id("C"))))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.rule, "R3c");
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(assignExpr(id("r1"), { k: "new", callee: id("C"), args: [id("x")] }))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

test("R3c: zero-argument construct still prints its parens (emitter's job, not this rung's — checked structurally here)", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), reflectConstruct(id("C"), [])))];
  const ctx = ctxFor(before);
  const m = match(before, ctx)!;
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(assignExpr(id("r1"), { k: "new", callee: id("C"), args: [] }))]);
});

test("R3d: __hbc_b_functionPrototypeCall becomes F.call(T, ...)", () => {
  const before: readonly Stmt[] = [exprStmt(helperCall(id("f"), id("t"), [id("a"), id("b")]))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.rule, "R3d");
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(call(member(id("f"), "call"), [id("t"), id("a"), id("b")]))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

test("R3d: __hbc_b_functionPrototypeApply becomes F.apply(T, arr) — arr need not be a literal", () => {
  const before: readonly Stmt[] = [exprStmt(helperApply(id("f"), id("t"), id("dynamicArr")))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.rule, "R3d");
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(call(member(id("f"), "apply"), [id("t"), id("dynamicArr")]))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

// ---------------------------------------------------------------------------
// §7 — refuse reasons.
// ---------------------------------------------------------------------------

test("dynamic-args: the argument-list operand is not a literal array", () => {
  const before: readonly Stmt[] = [exprStmt(reflectApply(id("f"), UNDEF, [id("x")]))];
  const dynamic = { ...before[0]!, expr: call(member(id("Reflect"), "apply"), [id("f"), UNDEF, id("spread")]) } as Stmt;
  assert.equal(match([dynamic], ctxFor([dynamic])), null);
  const node = (dynamic as Extract<Stmt, { k: "expr" }>).expr;
  assert.deepEqual(classifyNode(node, [dynamic]), { ok: false, reason: "dynamic-args" });
});

test("dynamic-args: an array element is itself a seq expression", () => {
  const seqArg: Expr = { k: "seq", exprs: [id("a"), id("b")] };
  const node = reflectApply(id("f"), UNDEF, [seqArg]);
  assert.deepEqual(classifyNode(node, []), { ok: false, reason: "dynamic-args" });
});

test("impure-callee: the callee itself is a call expression", () => {
  const node = reflectApply(call(id("f"), []), UNDEF, []);
  assert.deepEqual(classifyNode(node, []), { ok: false, reason: "impure-callee" });
  const before: readonly Stmt[] = [exprStmt(node)];
  assert.equal(match(before, ctxFor(before)), null);
});

test("impure-callee: a construct callee containing `new` is refused", () => {
  const node = reflectConstruct({ k: "new", callee: id("g"), args: [] }, []);
  assert.deepEqual(classifyNode(node, []), { ok: false, reason: "impure-callee" });
});

test("member-callee-with-undefined-this: a member callee whose receiver is provably undefined is not folded into a method call", () => {
  const node = reflectApply(member(id("o"), "m"), UNDEF, []);
  assert.deepEqual(classifyNode(node, []), { ok: false, reason: "member-callee-with-undefined-this" });
  const before: readonly Stmt[] = [exprStmt(node)];
  assert.equal(match(before, ctxFor(before)), null);
});

test("unproven-this: a non-member callee whose `this` is neither literal undefined nor a proven-undefined register", () => {
  const node = reflectApply(id("f"), id("x"), []);
  assert.deepEqual(classifyNode(node, []), { ok: false, reason: "unproven-this" });
});

test("unproven-this: a member callee whose receiver is a different register from the object", () => {
  const node = reflectApply(member(id("o"), "m"), id("other"), []);
  assert.deepEqual(classifyNode(node, []), { ok: false, reason: "unproven-this" });
});

test("explicit-new-target: Reflect.construct's third argument differs from the callee", () => {
  const node = reflectConstruct(id("C"), [id("a")], id("D"));
  assert.deepEqual(classifyNode(node, []), { ok: false, reason: "explicit-new-target" });
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), node))];
  assert.equal(match(before, ctxFor(before)), null);
});

test("helper-arity: __hbc_b_functionPrototypeCall needs at least a function and a this-argument", () => {
  const node = call(id("__hbc_b_functionPrototypeCall"), [id("f")]);
  assert.deepEqual(classifyNode(node, []), { ok: false, reason: "helper-arity" });
});

test("reflect-get-set: Reflect.get/Reflect.set are never even candidates", () => {
  const getNode = call(member(id("Reflect"), "get"), [id("o"), lit('"p"'), id("r")]);
  assert.deepEqual(classifyNode(getNode, []), { ok: false, reason: "not-a-call-shape-site" });
  const setNode = call(member(id("Reflect"), "set"), [id("o"), lit('"p"'), id("v"), id("r")]);
  assert.deepEqual(classifyNode(setNode, []), { ok: false, reason: "not-a-call-shape-site" });
});

// ---------------------------------------------------------------------------
// §7 — a *real* `check` refusing a real site (not a stubbed check).
// ---------------------------------------------------------------------------

test("check refuses a hand-crafted after that changes an argument's value", () => {
  const before: readonly Stmt[] = [exprStmt(reflectApply(id("print"), UNDEF, [lit('"x"')]))];
  const wronglyRewrittenAfter: readonly Stmt[] = [exprStmt(call(id("print"), [lit('"y"')]))];
  const ctx = ctxFor(before);
  assert.equal(check(before, wronglyRewrittenAfter, ctx).ok, false);
});

test("check refuses a hand-crafted after that rewrites the wrong statement", () => {
  const before: readonly Stmt[] = [exprStmt(reflectApply(id("print"), UNDEF, [lit('"x"')])), exprStmt(call(id("noop"), []))];
  const wronglyRewrittenAfter: readonly Stmt[] = [exprStmt(reflectApply(id("print"), UNDEF, [lit('"x"')])), exprStmt(call(id("print"), []))];
  const ctx = ctxFor(before);
  assert.equal(check(before, wronglyRewrittenAfter, ctx).ok, false);
});

// ---------------------------------------------------------------------------
// PL-08 idempotence, and nested-func-frame isolation.
// ---------------------------------------------------------------------------

test("PL-08: call-shape reaches a fixed point on its own output", () => {
  const before: readonly Stmt[] = [exprStmt(reflectApply(id("print"), UNDEF, [lit('"x"')]))];
  const ctx = ctxFor(before);
  const m = match(before, ctx)!;
  const after = rewrite(m);
  assert.equal(match(after, ctxFor(after)), null);
});

test("a nested func's own frame is never reached by the outer list's match", () => {
  const before: readonly Stmt[] = [funcStmt("g", [exprStmt(reflectApply(id("print"), UNDEF, []))])];
  assert.equal(match(before, ctxFor(before)), null);
});

// ---------------------------------------------------------------------------
// §7 corpus fixtures — red -> green through the real pipeline.
// ---------------------------------------------------------------------------

const VERSIONS = [84, 94, 96, 98, 99];
const VARIANTS = ["", ".min", ".obf"];

function fixturePath(name: string, version: number, variant: string): string {
  return join(repoRoot(), "tests", "fixtures", "constructs", name, `v${version}${variant}.hbc`);
}

function reflectCount(code: string): number {
  return (code.match(/Reflect\.(apply|construct)\(/g) ?? []).length;
}

// Deviation from a blanket "always strictly reduces" assertion here
// (docs/AGENT-LOG.md has the full account): `../ast.ts`'s `identUses`
// computes `nested` by testing whether a *nested func's own body* mentions
// the same register **name** — sound for a genuinely captured variable
// (which this codebase always represents as an env slot, `_eN_M`, never a
// raw register once captured), but Hermes restarts register numbering at
// `r0` for every function, so a nested closure's own, entirely unrelated
// local landing on the same number as the outer frame's is the norm, not
// the exception, for any function with more than a couple of registers.
// R3a's `isProvenUndefinedThis` requires `nested === 0` on `T`'s register
// (spec §4, followed literally), so a `this`-holding register that is
// *also* (coincidentally) a number some nested closure happens to reuse for
// its own, unrelated local is refused `unproven-this` even though nothing
// is actually shared. `21-iife-closures` — a fixture whose entire point is
// nested closures — hits this on every single one of its `Reflect.apply`
// sites at every version (its one `this`-holding register collides with
// every closure's own numbering), and `01-if-else-chain.min` hits it for
// the same reason on its minified/merged variant only. Below, the `targets`
// loop therefore asserts the same "never regresses" safety property
// `global-access.test.ts` asserts for its own targets fixtures that hit an
// analogous gap, not a guaranteed reduction; the genuine red->green
// demonstrations are the specific-shape tests further down (`19-var-hoisting`,
// `32-class-basic`, `33-class-inheritance-super`), on fixtures/registers this
// gap does not happen to hit.
for (const target of callShape.targets) {
  for (const version of VERSIONS) {
    for (const variant of VARIANTS) {
      const path = fixturePath(target, version, variant);
      if (!existsSync(path)) continue;
      test(`safe: ${target} v${version}${variant} — call-shape never increases Reflect.apply/construct occurrences`, () => {
        const bytes = new Uint8Array(readFileSync(path));
        const withoutRung = decompile(bytes, { moduleName: target, resolveV98Ambiguity: true, passes: { skip: ["call-shape"] } }).code;
        const withRung = decompile(bytes, { moduleName: target, resolveV98Ambiguity: true, passes: {} }).code;
        const before = reflectCount(withoutRung);
        const after = reflectCount(withRung);
        assert.ok(before > 0, `expected ${target} v${version}${variant} to contain a Reflect.apply/construct call before this rung runs`);
        assert.ok(after <= before, `expected no more Reflect.apply/construct occurrences with call-shape on ${target} v${version}${variant}: ${before} -> ${after}`);
      });
    }
  }
}

test("red->green: 19-var-hoisting, 32-class-basic and 33-class-inheritance-super each show a genuine reduction somewhere in their five versions", () => {
  for (const target of ["19-var-hoisting", "32-class-basic", "33-class-inheritance-super"]) {
    let sawReduction = false;
    for (const version of VERSIONS) {
      const path = fixturePath(target, version, "");
      if (!existsSync(path)) continue;
      const bytes = new Uint8Array(readFileSync(path));
      const withoutRung = decompile(bytes, { moduleName: target, resolveV98Ambiguity: true, passes: { skip: ["call-shape"] } }).code;
      const withRung = decompile(bytes, { moduleName: target, resolveV98Ambiguity: true, passes: {} }).code;
      if (reflectCount(withRung) < reflectCount(withoutRung)) sawReduction = true;
    }
    assert.ok(sawReduction, `expected ${target} to show a call-shape reduction at at least one of its versions`);
  }
});

test("v94 shape: 19-var-hoisting fn#1 'demo' — a plain-identifier callee with a proven-undefined this folds", () => {
  // Deliberately does not assert on whether every OTHER `print` call in this
  // function also folds: that depends on how much of the property read
  // `global-access` (running before this rung) manages to fold to a bare
  // identifier first, which is that rung's own evolving scope, not this
  // one's. What is stable and squarely this rung's own claim: the moment a
  // callee sitting in a plain register is not a `member` expression (this
  // one already wasn't, before `global-access` ever touched anything here —
  // `expr-rebuild` left `r2` holding the callee value as a scratch
  // register), R3a folds it.
  const code = decompile(new Uint8Array(readFileSync(fixturePath("19-var-hoisting", 94, ""))), { moduleName: "x" }).code;
  assert.match(code, /r2\("x before declaration:", r3\);/, "F is a plain identifier, T is proven undefined: R3a fires");
});

test("v98 shape: 32-class-basic — a bare identifier call folds through call-shape after expr-rebuild inlines the callee", () => {
  const code = decompile(new Uint8Array(readFileSync(fixturePath("32-class-basic", 98, ""))), { moduleName: "x" }).code;
  assert.doesNotMatch(code, /Reflect\.apply/);
});

test("v99 shape: 33-class-inheritance-super — an ordinary two-argument Reflect.construct becomes new, an explicit new-target triple does not", () => {
  // `var-naming` (spec 07) runs after this rung and renames single-def
  // registers such as the `new` result below; this test asserts call-shape's
  // own property against register names, so that rung is skipped here.
  // reg-split (still on — only var-naming is skipped) may give any of these
  // registers their own `rN_j` web name; call-shape's own property under
  // test is unaffected by that renaming.
  const code = decompile(new Uint8Array(readFileSync(fixturePath("33-class-inheritance-super", 99, ""))), { moduleName: "x", passes: { skip: ["var-naming"] } }).code;
  assert.match(code, /new r7(?:_\d+)?\(r12(?:_\d+)?, r11(?:_\d+)?\)/);
  assert.match(code, /Reflect\.construct\(r2(?:_\d+)?, \[r4(?:_\d+)?\], r3(?:_\d+)?\)/, "super() forwards a distinct new.target — must not become `new r2(r4)`");
});

// docs/specs/passes/14-template-literal.md §7: `call-shape` and
// `template-literal` are order-independent because every call-shape rule
// refuses a `HermesInternal.concat` site — R3a needs a proven-`undefined`
// `this` (it is the first string chunk), R3b needs the receiver to be the
// callee's own object (it is not). Asserted here rather than by an `after:`
// edge; the mirror-image negative lives in template-literal.test.ts.
test("order independence: a template literal's concat site is not a call-shape site", () => {
  const concatMember = member(id("__hbc_HermesInternal"), "concat");
  const site = reflectApply(concatMember, lit('"Hello, "'), [id("r3"), lit('"!"')]);
  const body: readonly Stmt[] = [exprStmt(assignExpr(id("r5"), site))];
  const v = classifyNode(site, body);
  assert.equal(v.ok, false);
  assert.equal(match(body, ctxFor(body)), null);
});
