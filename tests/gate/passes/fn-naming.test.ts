// docs/specs/passes/05-fn-naming.md — unit tests on hand-built ASTs (§7's
// checklist: one positive per rule; negatives for a reserved word, a name
// equal to an exposed global, two functions sharing a name, and the global
// function; a real `check` refusal), plus red->green on the fixture corpus
// at all five HBC versions and the .min/.obf tiers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import type { ModuleView } from "../../../src/passes/tree.ts";
import { check } from "../../../src/passes/fn-naming/check.ts";
import { fnNaming } from "../../../src/passes/fn-naming/index.ts";
import { classifySite, match } from "../../../src/passes/fn-naming/match.ts";
import { rewrite } from "../../../src/passes/fn-naming/rewrite.ts";
import type { PassContext } from "../../../src/passes/types.ts";

// ---------------------------------------------------------------------------
// Hand-built-AST helpers.
// ---------------------------------------------------------------------------

const assignExpr = (target: Expr, value: Expr): Expr => ({ k: "assign", target, value });
const exprStmt = (e: Expr): Stmt => ({ k: "expr", expr: e });
const member = (obj: Expr, prop: string): Expr => ({ k: "member", obj, prop: lit(prop), computed: false });
const funcStmt = (name: string, body: readonly Stmt[], params: readonly string[] = []): Stmt => ({ k: "func", name, params: params.map((n) => ({ name: n })), body });
const initStmt = (name: string, value: Expr): Stmt => ({ k: "init", kind: "let", name, value });
const declStmt = (names: readonly string[]): Stmt => ({ k: "decl", kind: "let", names });

/** A minimal `ModuleView`: `names[n]` is `functionName(n)` (default `""`),
 *  `globalIndex` (default 0) is the sole index `isGlobalFunction` accepts. */
function fakeModule(names: Readonly<Record<number, string>>, globalIndex = 0): ModuleView {
  return {
    functionCount: Math.max(globalIndex, ...Object.keys(names).map(Number)) + 1,
    functionName: (index: number): string => names[index] ?? "",
    isGlobalFunction: (index: number): boolean => index === globalIndex,
    envSlotAccesses: (): readonly { readonly functionIndex: number; readonly offset: number }[] => [],
    depsVerdict: (): null => null,
  };
}

function ctxFor(fnBody: readonly Stmt[], module: ModuleView): PassContext {
  return {
    analysis: null as unknown as PassContext["analysis"],
    functionIndex: 0,
    cfg: {} as PassContext["cfg"],
    hbcVersion: 94,
    layoutClass: "hbc94" as PassContext["layoutClass"],
    applied: [],
    diagnostic: () => {},
    fnBody,
    module,
  };
}

// ---------------------------------------------------------------------------
// §4 condition 2 — evidence from `functionName` directly.
// ---------------------------------------------------------------------------

test("positive: functionName evidence renames a top-level function, and every reference to it", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", [{ k: "return", arg: lit("1") }]), exprStmt(assignExpr(member(id("globalThis"), "demo"), id("_fn1")))];
  const module = fakeModule({ 1: "demo" });
  const ctx = ctxFor(before, module);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.deepEqual(m.data, { renames: [{ stmtIndex: 0, n: 1, from: "_fn1", to: "demo" }] });
  const after = rewrite(m);
  assert.deepEqual(after, [funcStmt("demo", [{ k: "return", arg: lit("1") }]), exprStmt(assignExpr(member(id("globalThis"), "demo"), id("demo")))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

test("positive: a recursive self-reference inside the function's own body is renamed too", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", [{ k: "return", arg: { k: "call", callee: id("_fn1"), args: [] } }])];
  const module = fakeModule({ 1: "fact" });
  const ctx = ctxFor(before, module);
  const m = match(before, ctx);
  assert.ok(m !== null);
  const after = rewrite(m);
  assert.deepEqual(after, [funcStmt("fact", [{ k: "return", arg: { k: "call", callee: id("fact"), args: [] } }])]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

// ---------------------------------------------------------------------------
// §4 R4b — name from the one qualifying assignment site.
// ---------------------------------------------------------------------------

test("positive: R4b recovers a name from a `X.key = _fnN` member write when functionName is empty", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", []), exprStmt(assignExpr(member(id("r0"), "demo"), id("_fn1")))];
  const module = fakeModule({ 1: "" });
  const ctx = ctxFor(before, module);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.renames[0]!.to, "demo");
  const after = rewrite(m);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

test("R4b's `init`-form evidence is recognised, but re-running condition 5 always refuses it: `key` is itself declared by the very `init` statement that names it, so renaming would redeclare that binding (`let helper = helper;`, invalid)", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", []), initStmt("helper", id("_fn1")), exprStmt({ k: "call", callee: id("helper"), args: [] })];
  const module = fakeModule({ 1: "" });
  assert.equal(match(before, ctxFor(before, module)), null);
  assert.deepEqual(classifySite(before, before, module, 0), { ok: false, reason: "already-declared" });
});

test("ambiguous-name: R4b refuses when two statements assign the same _fnN", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", []), exprStmt(assignExpr(member(id("r0"), "a"), id("_fn1"))), exprStmt(assignExpr(member(id("r0"), "b"), id("_fn1")))];
  const module = fakeModule({ 1: "" });
  assert.equal(match(before, ctxFor(before, module)), null);
  assert.deepEqual(classifySite(before, before, module, 0), { ok: false, reason: "ambiguous-name" });
});

test("anonymous: R4b's one candidate site is refused when _fnN has more than one read elsewhere too", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", []), exprStmt(assignExpr(member(id("r0"), "demo"), id("_fn1"))), exprStmt({ k: "call", callee: id("_fn1"), args: [] })];
  const module = fakeModule({ 1: "" });
  assert.equal(match(before, ctxFor(before, module)), null);
  assert.deepEqual(classifySite(before, before, module, 0), { ok: false, reason: "anonymous" });
});

test("anonymous: no functionName and no assignment-site evidence at all", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", []), exprStmt({ k: "call", callee: id("_fn1"), args: [] })];
  const module = fakeModule({ 1: "" });
  assert.equal(match(before, ctxFor(before, module)), null);
  assert.deepEqual(classifySite(before, before, module, 0), { ok: false, reason: "anonymous" });
});

// ---------------------------------------------------------------------------
// §7 refusals.
// ---------------------------------------------------------------------------

test("global-function: fn#0 is never renamed even with perfectly good evidence", () => {
  const before: readonly Stmt[] = [funcStmt("_fn0", [])];
  const module = fakeModule({ 0: "global" }, 0);
  assert.equal(match(before, ctxFor(before, module)), null);
  assert.deepEqual(classifySite(before, before, module, 0), { ok: false, reason: "global-function" });
});

test("unsafe-identifier: functionName is not a valid identifier", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", [])];
  const module = fakeModule({ 1: "123bad" });
  assert.equal(match(before, ctxFor(before, module)), null);
  assert.deepEqual(classifySite(before, before, module, 0), { ok: false, reason: "unsafe-identifier" });
});

test("reserved-word: functionName is a reserved word", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", [])];
  const module = fakeModule({ 1: "class" });
  assert.equal(match(before, ctxFor(before, module)), null);
  assert.deepEqual(classifySite(before, before, module, 0), { ok: false, reason: "reserved-word" });
});

test("emitter-name-class: functionName collides with a synthetic name shape", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", [])];
  const module = fakeModule({ 1: "_e1_0" });
  assert.equal(match(before, ctxFor(before, module)), null);
  assert.deepEqual(classifySite(before, before, module, 0), { ok: false, reason: "emitter-name-class" });
});

test("captures-free-name: functionName equals a name already free (exposed by global-access) in the function", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", []), exprStmt({ k: "call", callee: { k: "ident", name: "print", global: true }, args: [] })];
  const module = fakeModule({ 1: "print" });
  assert.equal(match(before, ctxFor(before, module)), null);
  assert.deepEqual(classifySite(before, before, module, 0), { ok: false, reason: "captures-free-name" });
});

test("already-declared: functionName equals a name declared elsewhere in the function", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", []), declStmt(["helper"])];
  const module = fakeModule({ 1: "helper" });
  assert.equal(match(before, ctxFor(before, module)), null);
  assert.deepEqual(classifySite(before, before, module, 0), { ok: false, reason: "already-declared" });
});

test("duplicate-name: two _fnN entries in the same list would claim the same raw name — both refused", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", []), funcStmt("_fn2", [])];
  const module = fakeModule({ 1: "helper", 2: "helper" });
  assert.equal(match(before, ctxFor(before, module)), null);
  assert.deepEqual(classifySite(before, before, module, 0), { ok: false, reason: "duplicate-name" });
  assert.deepEqual(classifySite(before, before, module, 1), { ok: false, reason: "duplicate-name" });
});

test("match picks the first qualifying candidate when an earlier one is refused", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", []), funcStmt("_fn2", [])];
  const module = fakeModule({ 1: "class", 2: "demo" }); // fn1 is a reserved word, fn2 qualifies
  const m = match(before, ctxFor(before, module));
  assert.ok(m !== null);
  assert.equal(m.data.renames.length, 1);
  assert.equal(m.data.renames[0]!.n, 2);
  assert.equal(m.data.renames[0]!.to, "demo");
});

// ---------------------------------------------------------------------------
// A real `check` refusal (not a stubbed check).
// ---------------------------------------------------------------------------

test("check refuses a hand-crafted `after` that renamed the func statement but left a reference untouched", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", []), exprStmt(assignExpr(member(id("globalThis"), "demo"), id("_fn1")))];
  const wronglyRewrittenAfter: readonly Stmt[] = [funcStmt("demo", []), exprStmt(assignExpr(member(id("globalThis"), "demo"), id("_fn1")))];
  const module = fakeModule({ 1: "demo" });
  const ctx = ctxFor(before, module);
  const verdict = check(before, wronglyRewrittenAfter, ctx);
  assert.equal(verdict.ok, false);
});

test("check refuses an `after` that introduces the target name at the wrong statement (a statement count changed)", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", []), exprStmt(assignExpr(member(id("globalThis"), "demo"), id("_fn1")))];
  const wronglyRewrittenAfter: readonly Stmt[] = [funcStmt("demo", []), exprStmt(assignExpr(member(id("globalThis"), "demo"), id("demo"))), exprStmt(id("demo"))];
  const module = fakeModule({ 1: "demo" });
  const verdict = check(before, wronglyRewrittenAfter, ctxFor(before, module));
  assert.equal(verdict.ok, false);
});

// ---------------------------------------------------------------------------
// PL-08 idempotence, and the root-list-only site restriction.
// ---------------------------------------------------------------------------

test("PL-08: fn-naming reaches a fixed point on its own output", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", []), exprStmt(assignExpr(member(id("globalThis"), "demo"), id("_fn1")))];
  const module = fakeModule({ 1: "demo" });
  const ctx = ctxFor(before, module);
  const m = match(before, ctx);
  assert.ok(m !== null);
  const after = rewrite(m);
  assert.equal(match(after, ctxFor(after, module)), null);
});

test("a nested func's own body is never itself a site: match returns null unless the list is exactly ctx.fnBody", () => {
  const inner: readonly Stmt[] = [funcStmt("_fn2", [])];
  const before: readonly Stmt[] = [funcStmt("_fn1", inner)];
  const module = fakeModule({ 1: "outer", 2: "inner" });
  // `ctx.fnBody` is the *outer* list; calling `match` directly on the nested
  // `inner` list must refuse, even though `inner` itself has a qualifying
  // candidate — the driver enumerates it separately, under its own context.
  assert.equal(match(inner, ctxFor(before, module)), null);
});

// ---------------------------------------------------------------------------
// §7 corpus fixtures — red -> green, and a full safety sweep.
// ---------------------------------------------------------------------------

const VERSIONS = [84, 94, 96, 98, 99];
const VARIANTS = ["", ".min", ".obf"];

function loadFixture(name: string, version: number, variant: string): Uint8Array {
  return new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, `v${version}${variant}.hbc`)));
}

function survivingFnTokens(code: string): number {
  return (code.match(/\b_fn\d+\b/g) ?? []).length;
}

// Safety property (PL-05-style): across every target, version and variant,
// turning fn-naming on never crashes and never *increases* the number of
// surviving `_fnN` tokens.
for (const target of fnNaming.targets) {
  for (const version of VERSIONS) {
    for (const variant of VARIANTS) {
      test(`safe: ${target} v${version}${variant} never crashes and never adds an _fnN token`, () => {
        const bytes = loadFixture(target, version, variant);
        const without = decompile(bytes, { moduleName: target, resolveV98Ambiguity: true, passes: { skip: ["fn-naming"] } }).code;
        const withRung = decompile(bytes, { moduleName: target, resolveV98Ambiguity: true, passes: {} }).code;
        assert.ok(survivingFnTokens(withRung) <= survivingFnTokens(without), `expected no more _fnN tokens with fn-naming on for ${target} v${version}${variant}`);
      });
    }
  }
}

// Red->green: at v94, base variant, every named function this rung has
// evidence for is recovered, and no `_fnN` token remains for it.
test("red->green: 19-var-hoisting v94 recovers demo and hoistedFn", () => {
  const code = decompile(loadFixture("19-var-hoisting", 94, ""), { moduleName: "x" }).code;
  assert.match(code, /function demo\(/);
  assert.match(code, /function hoistedFn\(/);
  assert.doesNotMatch(code, /\b_fn[1-9]\d*\b/, "only the global function (_fn0) should remain unrenamed");
});

test("red->green: 21-iife-closures v94 recovers increment/decrement/reset/value/selfRef; the anonymous IIFE stays _fn1", () => {
  const code = decompile(loadFixture("21-iife-closures", 94, ""), { moduleName: "x" }).code;
  for (const name of ["increment", "decrement", "reset", "value", "selfRef"]) {
    assert.match(code, new RegExp(`function ${name}\\(`), `expected function ${name}(`);
  }
  assert.doesNotMatch(code, /\b_fn[2-6]\b/, "fn#2..6 all have functionName evidence and should be renamed");
  assert.match(code, /\b_fn1\b/, "the outer IIFE (fn#1) is genuinely anonymous and should stay _fn1");
});

test("red->green: 22-nested-closures-counters v94 recovers named function expressions; the anonymous .reduce callback stays _fn6", () => {
  const code = decompile(loadFixture("22-nested-closures-counters", 94, ""), { moduleName: "x" }).code;
  for (const name of ["makeCounter", "step", "makeAccumulatorFactory", "makeAccumulator", "accumulate"]) {
    assert.match(code, new RegExp(`function ${name}\\(`), `expected function ${name}(`);
  }
  assert.doesNotMatch(code, /\b_fn[1-5]\b/);
  assert.match(code, /\b_fn6\b/, "the anonymous .reduce callback (fn#6) has no name evidence and should stay _fn6");
});

test("safety: 17-closure-loop-var v94 has no name evidence anywhere and stays entirely _fnN (never crashes)", () => {
  const without = decompile(loadFixture("17-closure-loop-var", 94, ""), { moduleName: "x", passes: { skip: ["fn-naming"] } }).code;
  const withRung = decompile(loadFixture("17-closure-loop-var", 94, ""), { moduleName: "x" }).code;
  assert.equal(withRung, without, "every closure here is genuinely anonymous; fn-naming should change nothing");
});
