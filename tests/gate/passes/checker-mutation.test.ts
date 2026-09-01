// CONSOLIDATION 4 — mutation-tests the M5 pass CHECKERS themselves (not the
// writers): for a table of plausible bad rewrites (the kind a future edit to
// a `rewrite.ts` could introduce — a wrong substituted value, a partial
// rename, a dropped argument, a wrong global name, ...), does `check(before,
// after, ctx)` actually reject `after`? Each case starts from a real,
// checker-accepted rewrite (`match`+`rewrite` on a hand-built `before`, same
// as this pass's own unit tests), then hand-mutates the *result* to simulate
// a wrong writer, deliberately never touching `src/`. A case that turns out
// to be ACCEPTED by the checker is a real hole: it is recorded here as a
// `{ todo: … }` case (never silently dropped or weakened) and the hole is
// filed in `docs/BUGS.md` (cluster: passes).
//
// Read `src/passes/README.md`'s contract before adding a case: `check` must
// reject any rewrite that is not exactly what the pass's own `rewrite`
// would have produced from `before`.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import type { ModuleView } from "../../../src/passes/tree.ts";
import type { PassContext } from "../../../src/passes/types.ts";

import { check as exprRebuildCheck } from "../../../src/passes/expr-rebuild/check.ts";
import { match as exprRebuildMatch } from "../../../src/passes/expr-rebuild/match.ts";

import { check as varNamingCheck } from "../../../src/passes/var-naming/check.ts";
import { match as varNamingMatch } from "../../../src/passes/var-naming/match.ts";
import { rewrite as varNamingRewrite } from "../../../src/passes/var-naming/rewrite.ts";

import { check as fnNamingCheck } from "../../../src/passes/fn-naming/check.ts";
import { match as fnNamingMatch } from "../../../src/passes/fn-naming/match.ts";
import { rewrite as fnNamingRewrite } from "../../../src/passes/fn-naming/rewrite.ts";

import { check as globalAccessCheck } from "../../../src/passes/global-access/check.ts";
import { match as globalAccessMatch } from "../../../src/passes/global-access/match.ts";
import { rewrite as globalAccessRewrite } from "../../../src/passes/global-access/rewrite.ts";

import { check as callShapeCheck } from "../../../src/passes/call-shape/check.ts";
import { match as callShapeMatch } from "../../../src/passes/call-shape/match.ts";
import { rewrite as callShapeRewrite } from "../../../src/passes/call-shape/rewrite.ts";

// ---------------------------------------------------------------------------
// Hand-built-AST helpers (mirrors each pass's own `*.test.ts`).
// ---------------------------------------------------------------------------

const assignExpr = (target: Expr, value: Expr): Expr => ({ k: "assign", target, value });
const exprStmt = (e: Expr): Stmt => ({ k: "expr", expr: e });
const set = (name: string, value: Expr): Stmt => exprStmt(assignExpr(id(name), value));
const call = (callee: Expr, args: readonly Expr[]): Expr => ({ k: "call", callee, args });
const member = (obj: Expr, prop: string): Expr => ({ k: "member", obj, prop: lit(prop), computed: false });
const arr = (elements: readonly Expr[]): Expr => ({ k: "array", elements });
const bin = (op: "+" | "*" | "<" | ">" | "===", left: Expr, right: Expr): Expr => ({ k: "bin", op, left, right });
const forStmt = (init: Expr | null, test: Expr, update: Expr | null, body: readonly Stmt[]): Stmt => ({ k: "for", label: null, init, test, update, body });
const funcStmt = (name: string, body: readonly Stmt[]): Stmt => ({ k: "func", name, params: [], body });
const declStmt = (names: readonly string[]): Stmt => ({ k: "decl", kind: "let", names });
const printCall = (...args: Expr[]): Stmt => exprStmt(call(id("print"), args));
const UNDEF: Expr = lit("undefined");
const reflectApply = (callee: Expr, thisArg: Expr, args: readonly Expr[]): Expr => call(member(id("Reflect"), "apply"), [callee, thisArg, arr(args)]);

const NORMAL_CFG = { generator: { info: { era: "none", kind: "normal" } } } as unknown as PassContext["cfg"];

function fakeModule(names: Readonly<Record<number, string>> = {}, globalIndex = 0): ModuleView {
  return {
    functionCount: Math.max(globalIndex, ...Object.keys(names).map(Number), 0) + 1,
    functionName: (index: number): string => names[index] ?? "",
    isGlobalFunction: (index: number): boolean => index === globalIndex,
    envSlotAccesses: (): readonly { readonly functionIndex: number; readonly offset: number }[] => [],
    depsVerdict: (): null => null,
  };
}
function ctxFor(fnBody: readonly Stmt[], extra: Partial<PassContext> = {}): PassContext {
  return { analysis: null as unknown as PassContext["analysis"], functionIndex: 0, cfg: NORMAL_CFG, hbcVersion: 94, layoutClass: "hbc94" as PassContext["layoutClass"], applied: [], diagnostic: () => {}, fnBody, ...extra };
}

/** Deep-clone a hand-built `after` so the mutation below never touches the
 *  node identities `rewrite` produced (some checkers key off object identity,
 *  not just structural equality, so a mutation must produce genuinely fresh
 *  nodes to be a fair test of a *value* the checker failed to re-derive). */
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// ---------------------------------------------------------------------------
// expr-rebuild — docs/specs/passes/02-expr-rebuild.md. `check` recomputes the
// site's *classification* (rule, deadness, purity) from `before` alone, and
// checks an exact read/write *count* delta on the target register — but
// never re-derives, and so never compares against, the actual value the
// writer folded in at the read site.
// ---------------------------------------------------------------------------

test("expr-rebuild/check rejects R1a folding in the wrong constant (docs/BUGS.md, 2026-09-01 checker-mutation row)", () => {
  // R1a: `r1 = 5; log(r1);` folds to `log(5);` — a store with a single
  // top-level read.
  const before: readonly Stmt[] = [set("r1", lit("5")), printCall(id("r1"))];
  const ctx = ctxFor(before);
  const m = exprRebuildMatch(before, ctx);
  assert.ok(m !== null, "expected R1a to match");
  // A wrong writer that folds in a different constant than `r1`'s actual
  // value (e.g. an off-by-one reading the wrong operand of the original
  // instruction) — same statement-count shape, same read/write delta on
  // `r1`, semantically wrong.
  const mutated: readonly Stmt[] = [printCall(lit("6"))];
  assert.deepEqual(exprRebuildCheck(before, mutated, ctx), { ok: false, reason: "the rewrite did not fold in the expected value" });
});

test("expr-rebuild/check rejects R1a folding the right operand with the wrong operator", () => {
  // R1a: `r1 = 2 + 3; log(r1);` folds to `log(2 + 3);` — a wrong writer that
  // keeps both operands but flips `+` to `*` (same shape, same
  // read/write delta on `r1`, wrong value).
  const before: readonly Stmt[] = [set("r1", bin("+", lit("2"), lit("3"))), printCall(id("r1"))];
  const ctx = ctxFor(before);
  const m = exprRebuildMatch(before, ctx);
  assert.ok(m !== null, "expected R1a to match");
  const mutated: readonly Stmt[] = [printCall(bin("*", lit("2"), lit("3")))];
  assert.deepEqual(exprRebuildCheck(before, mutated, ctx), { ok: false, reason: "the rewrite did not fold in the expected value" });
});

test("expr-rebuild/check rejects R1a folding in the wrong operand register", () => {
  // R1a: `r1 = r2; log(r1);` folds to `log(r2);` — a wrong writer that
  // instead folds in an unrelated register `r3` (same shape, same
  // read/write delta on `r1`, wrong value).
  const before: readonly Stmt[] = [set("r1", id("r2")), printCall(id("r1"))];
  const ctx = ctxFor(before, { fnBody: [set("r1", id("r2")), printCall(id("r1"))] });
  const m = exprRebuildMatch(before, ctx);
  assert.ok(m !== null, "expected R1a to match");
  const mutated: readonly Stmt[] = [printCall(id("r3"))];
  assert.deepEqual(exprRebuildCheck(before, mutated, ctx), { ok: false, reason: "the rewrite did not fold in the expected value" });
});

// ---------------------------------------------------------------------------
// var-naming — docs/specs/passes/07-var-naming.md. `check` recovers the
// (from, to) pairs from the `decl` statement, then verifies via a full
// print-undo round-trip that every occurrence was renamed consistently.
// ---------------------------------------------------------------------------

test("var-naming/check rejects a partial rename (one occurrence left as the old register name)", () => {
  const before: readonly Stmt[] = [
    declStmt(["r0", "r1"]),
    set("r1", lit("10")),
    forStmt(assignExpr(id("r0"), lit("0")), bin("<", id("r0"), id("r1")), assignExpr(id("r0"), bin("+", id("r0"), lit("1"))), [printCall(id("r0"))]),
  ];
  const ctx = ctxFor(before, { module: fakeModule() });
  const m = varNamingMatch(before, ctx);
  assert.ok(m !== null, "expected heuristic #1 to match r0 -> i");
  const correct = clone(varNamingRewrite(m));
  // A writer bug that renames the `decl` and the loop header but misses the
  // body's own read.
  const mutated = clone(correct) as Stmt[];
  (mutated[2] as unknown as { body: Stmt[] }).body[0] = printCall({ k: "ident", name: "r0" });
  assert.deepEqual(varNamingCheck(before, mutated, ctx), { ok: false, reason: "the rewrite changed the function's free-name set beyond replacing from with to" });
});

test("var-naming/check rejects a rename that collides with a name free in the body", () => {
  const before: readonly Stmt[] = [
    declStmt(["r0", "r1"]),
    set("r1", lit("10")),
    forStmt(assignExpr(id("r0"), lit("0")), bin("<", id("r0"), id("r1")), assignExpr(id("r0"), bin("+", id("r0"), lit("1"))), [printCall(id("r0")), exprStmt(call(id("console"), []))]),
  ];
  const ctx = ctxFor(before, { module: fakeModule() });
  const m = varNamingMatch(before, ctx);
  assert.ok(m !== null);
  const correct = varNamingRewrite(m);
  // A writer bug that picks a name already free in the body ("console")
  // instead of the pool's own choice ("i").
  const mutated = clone(correct) as unknown[];
  const rename = (n: unknown): void => {
    if (n !== null && typeof n === "object") {
      const o = n as Record<string, unknown>;
      if (o["k"] === "ident" && o["name"] === "i") o["name"] = "console";
      if (Array.isArray(o["names"])) o["names"] = (o["names"] as string[]).map((x) => (x === "i" ? "console" : x));
      for (const v of Object.values(o)) rename(v);
    } else if (Array.isArray(n)) n.forEach(rename);
  };
  rename(mutated);
  assert.deepEqual(varNamingCheck(before, mutated as readonly Stmt[], ctx), { ok: false, reason: "captures-free-name" });
});

// ---------------------------------------------------------------------------
// fn-naming — docs/specs/passes/05-fn-naming.md. Same print-undo shape as
// var-naming, over `func` statement names instead of registers.
// ---------------------------------------------------------------------------

test("fn-naming/check rejects a partial rename (a reference left as the old _fnN name)", () => {
  const before: readonly Stmt[] = [funcStmt("_fn1", [{ k: "return", arg: lit("1") }]), exprStmt(assignExpr(member(id("globalThis"), "demo"), id("_fn1")))];
  const ctx = ctxFor(before, { module: fakeModule({ 1: "demo" }) });
  const m = fnNamingMatch(before, ctx);
  assert.ok(m !== null, "expected functionName evidence to rename _fn1 -> demo");
  const correct = clone(fnNamingRewrite(m)) as Stmt[];
  // A writer bug that renames the `func` statement but misses the
  // `globalThis.demo = _fn1` reference.
  (correct[1] as unknown as { expr: { value: Expr } }).expr.value = { k: "ident", name: "_fn1" };
  assert.deepEqual(fnNamingCheck(before, correct, ctx), { ok: false, reason: "the rewrite changed the function's free-name set beyond replacing from with to" });
});

// ---------------------------------------------------------------------------
// global-access — docs/specs/passes/03-global-access.md. `check` recomputes
// the expected substitution via the same pure `substitute` builder
// `rewrite.ts` uses and compares the result to `after` byte-for-byte.
// ---------------------------------------------------------------------------

function globalAccessBefore(): readonly Stmt[] {
  return [
    exprStmt(assignExpr(id("r1"), id("globalThis"))),
    {
      k: "if",
      test: { k: "unary", op: "!", arg: { k: "bin", op: "in", left: lit('"Array"'), right: id("r1") } },
      then: [{ k: "throw", arg: { k: "new", callee: id("ReferenceError"), args: [lit(`"Property 'Array' doesn't exist"`)] } }],
      else: [],
    },
    exprStmt(reflectApply(member(id("r1"), "Array"), id("undefined"), [])),
  ];
}

test("global-access/check rejects substituting the wrong global name", () => {
  const before = globalAccessBefore();
  const ctx = ctxFor(before);
  const m = globalAccessMatch(before, ctx);
  assert.ok(m !== null, "expected the globalThis.Array guard to match");
  const correct = clone(globalAccessRewrite(m)) as Stmt[];
  // A writer bug that substitutes a different (also-proven-shaped) global
  // name than the one the guard actually named.
  (correct[1] as unknown as { expr: { args: Expr[] } }).expr.args[0] = { k: "ident", name: "Object", global: true } as Expr;
  assert.deepEqual(globalAccessCheck(before, correct, ctx), { ok: false, reason: "the rewrite did not exactly substitute the matched read" });
});

// ---------------------------------------------------------------------------
// call-shape — docs/specs/passes/04-call-shape.md. `check` recomputes the
// expected replacement via the same pure `applyReplacement` builder
// `rewrite.ts` uses and compares the result to `after` byte-for-byte.
// ---------------------------------------------------------------------------

test("call-shape/check rejects a dropped argument", () => {
  const before: readonly Stmt[] = [exprStmt(reflectApply(id("print"), UNDEF, [lit('"x"'), id("y")]))];
  const ctx = ctxFor(before);
  const m = callShapeMatch(before, ctx);
  assert.ok(m !== null, "expected R3a to match");
  const correct = clone(callShapeRewrite(m)) as Stmt[];
  // A writer bug that drops one of the real arguments while rebuilding the
  // call.
  (correct[0] as unknown as { expr: { args: Expr[] } }).expr.args = (correct[0] as unknown as { expr: { args: Expr[] } }).expr.args.slice(0, 1);
  assert.deepEqual(callShapeCheck(before, correct, ctx), { ok: false, reason: "the rewrite did not exactly replace the matched call node" });
});
