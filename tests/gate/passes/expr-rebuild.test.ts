// docs/specs/passes/02-expr-rebuild.md — unit tests on hand-built ASTs (§9's
// checklist item 3: one positive per rule, negatives for two-reads,
// impure-move, and a real `check` refusal), plus red->green on the fixture
// corpus at all five HBC versions and the .min/.obf tiers. `nested-capture`
// (the spec's original §7 refuse reason) was removed as a framework fix —
// see the "scoped analysis" tests below and `docs/AGENT-LOG.md`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { bin, id, lit } from "../../../src/emit/ast.ts";
import { identUses } from "../../../src/passes/ast.ts";
import { check } from "../../../src/passes/expr-rebuild/check.ts";
import { exprRebuild } from "../../../src/passes/expr-rebuild/index.ts";
import { classifySite, match } from "../../../src/passes/expr-rebuild/match.ts";
import { rewrite } from "../../../src/passes/expr-rebuild/rewrite.ts";
import type { PassContext } from "../../../src/passes/types.ts";

const assignExpr = (target: Expr, value: Expr): Expr => ({ k: "assign", target, value });
const exprStmt = (e: Expr): Stmt => ({ k: "expr", expr: e });
const call = (callee: Expr, args: readonly Expr[]): Expr => ({ k: "call", callee, args });
const funcStmt = (name: string, body: readonly Stmt[]): Stmt => ({ k: "func", name, params: [], body });

const NORMAL_CFG = { generator: { info: { era: "none", kind: "normal" } } } as unknown as PassContext["cfg"];
const GENERATOR_CFG = { generator: { info: { era: "opcode", kind: "generator" } } } as unknown as PassContext["cfg"];

function ctxFor(fnBody: readonly Stmt[], cfg: PassContext["cfg"] = NORMAL_CFG): PassContext {
  return {
    analysis: null as unknown as PassContext["analysis"],
    functionIndex: 0,
    cfg,
    hbcVersion: 94,
    layoutClass: "hbc94" as PassContext["layoutClass"],
    applied: [],
    diagnostic: () => {},
    fnBody,
  };
}

// ---------------------------------------------------------------------------
// §4/§5 — one positive per rule.
// ---------------------------------------------------------------------------

test("R1a: forward inline — a pure value with a single top-level read folds in, deleting the store", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), lit("5"))), exprStmt(call(id("log"), [id("r1")]))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.rule, "R1a");
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(call(id("log"), [lit("5")]))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

test("R1b: dead store — overwritten before ever being read is deleted (pure value)", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), lit("5"))), exprStmt(assignExpr(id("r1"), lit("6"))), exprStmt(call(id("use"), [id("r1")]))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.rule, "R1b");
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(assignExpr(id("r1"), lit("6"))), exprStmt(call(id("use"), [id("r1")]))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

test("R1b: dead store — an impure value keeps its effect, drops the store", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), call(id("sideEffect"), []))), exprStmt(assignExpr(id("r1"), lit("6"))), exprStmt(call(id("use"), [id("r1")]))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.rule, "R1b");
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(call(id("sideEffect"), [])), exprStmt(assignExpr(id("r1"), lit("6"))), exprStmt(call(id("use"), [id("r1")]))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

test("R1c: self-move — always matches, always safe, regardless of later reads", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("r1"))), exprStmt(call(id("use"), [id("r1")])), exprStmt(call(id("use2"), [id("r1")]))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.rule, "R1c");
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(call(id("use"), [id("r1")])), exprStmt(call(id("use2"), [id("r1")]))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

// ---------------------------------------------------------------------------
// §7 — refuse reasons: negatives (match finds nothing at all).
// ---------------------------------------------------------------------------

test("two-reads: a single later statement reading rX twice refuses (would duplicate an allocation/effect)", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), lit("5"))), exprStmt(call(id("log"), [id("r1"), id("r1")]))];
  assert.equal(match(before, ctxFor(before)), null);
  const v = classifySite(before, before, 0, "r1", lit("5"));
  assert.deepEqual(v, { ok: false, reason: "two-reads" });
});

test("impure-move: an impure value may only travel to the very next statement", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), call(id("foo"), []))), exprStmt(call(id("bar"), [])), exprStmt(call(id("use"), [id("r1")]))];
  assert.equal(match(before, ctxFor(before)), null);
  const v = classifySite(before, before, 0, "r1", call(id("foo"), []));
  assert.deepEqual(v, { ok: false, reason: "impure-move" });
});

// Consolidation item 3 (docs/BUGS.md, `01-if-else-chain.min` v84/v94 wrong
// output): the shape label-clean leaves behind for a minified if/else chain
// — the store, an `if` whose arm `break`s to a label *outside* the site
// (`L0`, whose continuation is `return r0`), then a redefinition. The scan
// used to treat the `if`'s inconclusive verdict as "irrelevant, keep going",
// step on to `r0 = r1` and delete `r0 = "negative"` — the value `break L0`
// carries to the `return`. An escape the site cannot follow is terminal.
test("not-dead (item 3): a store is live across an `if` that `break`s to a label outside the site, even with a redefinition after the `if`", () => {
  const site: readonly Stmt[] = [
    exprStmt(assignExpr(id("r0"), lit('"negative"'))),
    { k: "if", test: id("r6"), then: [{ k: "break", label: "L0" }], else: [] },
    exprStmt(assignExpr(id("r0"), id("r1"))),
    { k: "break", label: "L0" },
  ];
  const fnBody: readonly Stmt[] = [{ k: "labeled", label: "L0", body: site }, { k: "return", arg: id("r0") }];
  assert.equal(match(site, ctxFor(fnBody)), null, "nothing at this site may fold: `r0 = \"negative\"` is read by the `return` behind `break L0`");
  const v = classifySite(site, fnBody, 0, "r0", lit('"negative"'));
  assert.deepEqual(v, { ok: false, reason: "not-dead" });
});

// The same scan must still prove a store dead through an `if` whose escape
// is a label-less `break` out of the enclosing `switch`/loop (that `break`
// lands on the statement's own continuation, where the redefinition is).
test("item 3 control: a label-less `break` inside a `switch` case follows the switch's own continuation, so the store before it still folds", () => {
  const before: readonly Stmt[] = [
    exprStmt(assignExpr(id("r0"), lit("1"))),
    { k: "switch", disc: id("r6"), cases: [{ test: lit("0"), body: [exprStmt(call(id("f"), [])), { k: "break", label: null }] }] },
    exprStmt(assignExpr(id("r0"), lit("2"))),
    exprStmt(call(id("use"), [id("r0")])),
  ];
  const v = classifySite(before, before, 0, "r0", lit("1"));
  assert.deepEqual(v, { ok: true, rule: "R1b", j: 0 });
});

// `nested-capture` (a bare `identUses(fnBody, reg).nested > 0` refusal) was
// removed: Hermes restarts register numbering per function, so a nested
// `func`'s own body mentioning the literal name `r1` is provably that
// closure's *own*, unrelated local (a genuine capture is always copied to a
// collision-free env-slot name, `_e<env>_<slot>`, before crossing the
// function boundary — see `IdentUses.nested`'s doc in `../../../src/passes
// /ast.ts`), never a reference to this frame's `r1`. The shape below used to
// refuse `nested-capture` even though `g`'s own `r1` has nothing to do with
// this one; it now correctly folds as an ordinary dead store (R1b).
test("scoped analysis: a same-numbered register in a nested func's own frame is not a capture — the dead store still folds", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), lit("5"))), funcStmt("g", [exprStmt(call(id("use"), [id("r1")]))])];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.rule, "R1b");
  const after = rewrite(m);
  assert.deepEqual(after, [funcStmt("g", [exprStmt(call(id("use"), [id("r1")]))])]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
  const v = classifySite(before, before, 0, "r1", lit("5"));
  assert.deepEqual(v, { ok: true, rule: "R1b", j: 0 });
});

// The scoping is symmetric: a genuine capture of *this* frame's `r1` by a
// nested closure would have to show up as an env-slot write reachable from
// this list (e.g. `_e0_0 = r1`) followed by the closure reading `_e0_0`, not
// as a re-mention of `r1` itself — `identUses`'s framework test file covers
// that non-register, real-cross-scope case directly.
test("scoped analysis: a *different* register number in the nested func is unaffected either way (sanity)", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), lit("5"))), funcStmt("g", [exprStmt(call(id("use"), [id("r9")]))])];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.rule, "R1b");
});

test("input-clobbered: a pure value may not travel across a statement that overwrites a register it reads", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("r2"))), exprStmt(assignExpr(id("r2"), lit("9"))), exprStmt(call(id("use"), [id("r1")]))];
  // r1 = r2 is not a self-move (different registers), so R1a is the only candidate.
  const v = classifySite(before, before, 0, "r1", id("r2"));
  assert.deepEqual(v, { ok: false, reason: "input-clobbered" });
});

test("use-under-control-flow: the only read living inside a loop body (not a test) refuses", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), lit("5"))), { k: "while", label: null, test: id("cond"), body: [exprStmt(call(id("use"), [id("r1")]))] }];
  assert.equal(match(before, ctxFor(before)), null);
  const v = classifySite(before, before, 0, "r1", lit("5"));
  assert.deepEqual(v, { ok: false, reason: "use-under-control-flow" });
});

test("protocol-name: a non-register target (__pc, an env slot, …) is never a candidate", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("__pc"), lit("1"))), exprStmt(call(id("use"), [id("__pc")]))];
  assert.equal(match(before, ctxFor(before)), null);
});

test("generator-frame: a v<=96 generator body refuses the whole function", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), lit("5"))), exprStmt(call(id("log"), [id("r1")]))];
  assert.equal(match(before, ctxFor(before, GENERATOR_CFG)), null);
});

// ---------------------------------------------------------------------------
// H1 (docs/reviews/M5-pass-2-3.md): a loop `test` re-executes every
// iteration, so folding a value into it is only sound if the value is
// loop-invariant — no register it reads may be written by the loop's own
// body (or, for `for`, its `update`). Review's own reproduction: `r1 = 5;
// r0 = r1 + 0; while (r0) { r1 = r1 - 1 }` folds (`check` passes) into
// `r1 = 5; while (r1 + 0) { r1 = r1 - 1 }`, which is an infinite loop —
// `r0` was a one-time snapshot of `r1`, but the fold turns it into a
// per-iteration re-read of a register the loop body keeps decrementing.
// ---------------------------------------------------------------------------

test("loop-variant-input: a pure value folded into a while-test refuses when the loop body writes an input it reads", () => {
  // r0 = r1 + 0; while (r0) { r1 = r1 - 1 }  — r0's value is a one-time
  // snapshot of r1, but r1 changes every iteration once folded into the test.
  const before: readonly Stmt[] = [
    exprStmt(assignExpr(id("r0"), bin("+", id("r1"), lit("0")))),
    { k: "while", label: null, test: id("r0"), body: [exprStmt(assignExpr(id("r1"), bin("-", id("r1"), lit("1"))))] },
  ];
  assert.equal(match(before, ctxFor(before)), null, "the whole-function match must refuse, not just classifySite in isolation");
  const v = classifySite(before, before, 0, "r0", bin("+", id("r1"), lit("0")));
  assert.deepEqual(v, { ok: false, reason: "loop-variant-input" });
});

test("loop-variant-input: the same shape refuses for do-while and for loops too", () => {
  const value = bin("+", id("r1"), lit("0"));
  const bodyDecrementsR1: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), bin("-", id("r1"), lit("1"))))];

  const doWhile: readonly Stmt[] = [exprStmt(assignExpr(id("r0"), value)), { k: "do-while", label: null, test: id("r0"), body: bodyDecrementsR1 }];
  assert.equal(match(doWhile, ctxFor(doWhile)), null);

  // for (;;r1 = r1 - 1) { }  — the input is clobbered by the `update`, not the body.
  const forUpdate: readonly Stmt[] = [
    exprStmt(assignExpr(id("r0"), value)),
    { k: "for", label: null, init: null, test: id("r0"), update: assignExpr(id("r1"), bin("-", id("r1"), lit("1"))), body: [] },
  ];
  assert.equal(match(forUpdate, ctxFor(forUpdate)), null);
});

test("loop-variant-input: an impure value is refused outright in a loop test, even adjacent (j === i + 1)", () => {
  // r0 = sideEffect(); while (r0) { }  — folding would repeat the call every
  // iteration instead of running it once; `namesReadBy` is meaningless for
  // an impure value, so this must be refused without ever asking it.
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r0"), call(id("sideEffect"), []))), { k: "while", label: null, test: id("r0"), body: [] }];
  assert.equal(match(before, ctxFor(before)), null);
  const v = classifySite(before, before, 0, "r0", call(id("sideEffect"), []));
  assert.deepEqual(v, { ok: false, reason: "loop-variant-input" });
});

test("loop-invariant control: a value folded into a while-test still folds when the loop body leaves its inputs alone", () => {
  // r0 = r1 + 0; while (r0) { r2 = r2 - 1 }  — r1 is never written by the
  // loop, so r0's snapshot is safe to re-derive every iteration.
  const before: readonly Stmt[] = [
    exprStmt(assignExpr(id("r0"), bin("+", id("r1"), lit("0")))),
    { k: "while", label: null, test: id("r0"), body: [exprStmt(assignExpr(id("r2"), bin("-", id("r2"), lit("1"))))] },
  ];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null, "a genuinely loop-invariant value must still fold");
  assert.equal(m.data.rule, "R1a");
  const after = rewrite(m);
  assert.deepEqual(after, [{ k: "while", label: null, test: bin("+", id("r1"), lit("0")), body: [exprStmt(assignExpr(id("r2"), bin("-", id("r2"), lit("1"))))] }]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

// ---------------------------------------------------------------------------
// §9 — a *real* `check` refusing a real site (not a stubbed check).
// ---------------------------------------------------------------------------

test("check refuses a site where rX is genuinely still read later, even though the shape looks like a valid R1a fold", () => {
  // Two separate reads of r1 in two different statements: neither is
  // "exactly once" in the sense R1a needs (folding the first would leave the
  // second dangling), so classifySite proves `not-dead` on `before` — and
  // `check` must independently reach the same conclusion `match` would,
  // rather than trusting an `after` that looks locally plausible.
  const notDeadBefore: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), lit("5"))), exprStmt(call(id("log"), [id("r1")])), exprStmt(call(id("log2"), [id("r1")]))];
  const wronglyFoldedAfter: readonly Stmt[] = [exprStmt(call(id("log"), [lit("5")])), exprStmt(call(id("log2"), [id("r1")]))];
  const ctx = ctxFor(notDeadBefore);
  assert.equal(match(notDeadBefore, ctx), null, "a correct match must already refuse this site");
  const verdict = check(notDeadBefore, wronglyFoldedAfter, ctx);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "not-dead");
});

// ---------------------------------------------------------------------------
// PL-08 idempotence: a second `match` on the rewrite's own output finds nothing.
// ---------------------------------------------------------------------------

test("PL-08: expr-rebuild reaches a fixed point on its own output", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), lit("5"))), exprStmt(call(id("log"), [id("r1")]))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  const after = rewrite(m);
  assert.equal(match(after, ctxFor(after)), null);
});

// ---------------------------------------------------------------------------
// §7 corpus fixtures — red -> green.
// ---------------------------------------------------------------------------

const VERSIONS = [84, 94, 96, 98, 99];
const VARIANTS = ["", ".min", ".obf"];

function loadFixture(name: string, version: number, variant: string): Uint8Array {
  return new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, `v${version}${variant}.hbc`)));
}

function registerOccurrences(code: string): number {
  return (code.match(/\br\d+\b/g) ?? []).length;
}

for (const target of exprRebuild.targets) {
  for (const version of VERSIONS) {
    for (const variant of VARIANTS) {
      test(`red->green: ${target} v${version}${variant} — expr-rebuild strictly reduces register occurrences`, () => {
        const bytes = loadFixture(target, version, variant);
        const withoutRung = decompile(bytes, { moduleName: target, passes: { skip: ["expr-rebuild"] } }).code;
        const withRung = decompile(bytes, { moduleName: target, passes: {} }).code;
        assert.ok(registerOccurrences(withRung) < registerOccurrences(withoutRung), `expected fewer register occurrences with expr-rebuild on ${target} v${version}${variant}`);
      });
    }
  }
}

// Concrete before/after shapes, v94 (§1's worked example, plus two more
// verified against the real fixtures).
//
// Deviation from spec §1's illustrated shape (docs/AGENT-LOG.md): the spec's
// own example folds `19-var-hoisting`'s fn#1 "demo" all the way to
// `Reflect.apply(r1.print, undefined, [...])` for its *first* `print` call,
// with `r2` (holding `r1.print`, an impure member read) folded in despite
// two statements sitting between its store and its use. §4's own R1a rule
// requires an impure `E` to travel only to `j === i + 1` ("no intervening
// statement at all") — literally followed, that leaves `r2` (and `r3`, its
// neighbour) as identifiers in the first call. This rung does follow that
// rule literally (a deliberate, documented choice over loosening it to match
// the illustration — see the corpus-metric test's comment for the
// soundness argument *for* loosening it, and why it was tried and reverted:
// it measurably shrank the corpus-wide fold on some fixtures). Every *other*
// register in "demo" folds exactly as the rung's own rules predict — the
// repeated `if (!("print" in r1)) { throw ... }` guard between each `.print`
// access does *not* block D-a, since a single-branch `if` whose only
// branches are "throw" and "fall through untouched" resolves to `clear`,
// letting the scan continue past it to the next redefinition. The 14-name
// register declaration collapses to 5, and (a further improvement since the
// scoped-`identUses` framework fix, docs/AGENT-LOG.md: `fn#0`'s own `r3`
// no longer collides-and-refuses against nested `demo`/`hoistedFn`'s own,
// unrelated registers) call-shape now proves every one of "demo"'s five
// `Reflect.apply` this-registers `undefined` and folds all five to bare
// calls, not just three.
test("v94 shape: 19-var-hoisting fn#1 'demo' — guard-`if`s between accesses do not block D-a", () => {
  const code = decompile(loadFixture("19-var-hoisting", 94, ""), { moduleName: "x" }).code;
  assert.match(code, /let r0, r1, r2, r3, r4;/, "14 registers collapse to 5");
  assert.match(code, /r2\("x before declaration:", r3\);/, "r2 (impure, non-adjacent) stays a name; the pure literal folds in, and call-shape now proves this-undefined and drops Reflect.apply");
  assert.match(code, /print\("x after assignment:", 1\);/, "an adjacent impure read (no intervening statement) folds, and call-shape now proves this-undefined and drops Reflect.apply");
  assert.match(code, /r4\("x reassigned in block:", r0\);/);
  assert.match(code, /r4\("x after block:", r0\);/);
});

test("v94 shape: 19-var-hoisting fn#2 'hoistedFn' — R1a folds a single-use store into its return", () => {
  // Named `_fn2` -> `hoistedFn` by `fn-naming` (row R4) since this batch —
  // stale as `function _fn2(...)`, updated to the current, further-improved
  // output; the R1a fold under test is otherwise unaffected.
  const code = decompile(loadFixture("19-var-hoisting", 94, ""), { moduleName: "x" }).code;
  assert.match(code, /function hoistedFn\(\) \{\s*\/\/ fn#2 "hoistedFn"\s*return "hoisted";\s*\}/);
});

test("v94 shape: 02-while-loop — a six-times-reused register folds its string concatenation forward", () => {
  const code = decompile(loadFixture("02-while-loop", 94, ""), { moduleName: "x" }).code;
  assert.match(code, /r12 = "breaking at i=" \+ r7;/);
  // call-shape (pre-existing, unrelated to this file's own fix) already
  // proves this call's `this` register undefined and drops Reflect.apply
  // entirely — see docs/STATUS.md's note on the 3 stale v94-shape assertions.
  assert.match(code, /r8 = r10\(r12 \+ " computed=" \+ r11\);/);
  // The pre-rung baseline still shows the one-statement-per-instruction shape.
  const baseline = decompile(loadFixture("02-while-loop", 94, ""), { moduleName: "x", passes: { skip: ["expr-rebuild"] } }).code;
  assert.match(baseline, /r8 = "breaking at i=";/);
  assert.match(baseline, /r12 = r8 \+ r7;/);
});

test("v94 shape: 01-if-else-chain — a member-read callee folds into its call site", () => {
  const code = decompile(loadFixture("01-if-else-chain", 94, ""), { moduleName: "x" }).code;
  // `member-callee-with-undefined-this` correctly still refuses this one —
  // `r1.check.apply(undefined, [r8])` cannot become `r1.check(r8)` (that
  // would change `this` from `undefined` to `r1.check`'s object, `r1`).
  assert.match(code, /Reflect\.apply\(r1\.check, r3, \[r8\]\)/);
  // The pre-rung baseline: also skip `call-shape` (not just `expr-rebuild`)
  // to isolate expr-rebuild's own contribution here. Since the scoped-
  // `identUses` fix (docs/AGENT-LOG.md), call-shape alone — before
  // expr-rebuild folds `r1.check`'s member-read into the call site — already
  // proves `r3` undefined for the then-bare-ident callee `r6` and folds it
  // to a plain call (a *different*, and correct, shape: an already-
  // materialised callee value called with an undefined `this` has no
  // receiver to preserve, unlike the member-callee case above), which would
  // otherwise mask what this test means to demonstrate.
  const baseline = decompile(loadFixture("01-if-else-chain", 94, ""), { moduleName: "x", passes: { skip: ["expr-rebuild", "call-shape"] } }).code;
  assert.match(baseline, /r6 = r1\.check;/);
  assert.match(baseline, /r6 = Reflect\.apply\(r6, r3, \[r8\]\);/);
});

// ---------------------------------------------------------------------------
// Sanity: identUses agrees with the rewrite's own bookkeeping claim (item 4).
// ---------------------------------------------------------------------------

test("item 4 sanity: R1a removes exactly one read and one write of the folded register", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), lit("5"))), exprStmt(call(id("log"), [id("r1")]))];
  const ctx = ctxFor(before);
  const m = match(before, ctx)!;
  const after = rewrite(m);
  const bu = identUses(before, "r1");
  const au = identUses(after, "r1");
  assert.equal(bu.reads - au.reads, 1);
  assert.equal(bu.writes - au.writes, 1);
});

// ---------------------------------------------------------------------------
// if-chain regression (M5 rung 9, 2026-09-01): found by T2 the moment
// if-chain's C1 produced the guard shape on 51-default-params (and 21/38/39/
// 46, base and .min, v94+v99) — `r0 = arguments[1]; if (r0 !== r1) { break
// L0 }; r0 = fresh` folded the store into the test although the `break` path
// runs straight into `return r0` outside the list. Fails before the
// `classifySite` consumer-jump guard, passes after.
// ---------------------------------------------------------------------------

test("if-chain regression: a break inside the consuming statement escapes with the stale value — refuse", () => {
  const before: Stmt[] = [
    exprStmt(assignExpr(id("r0"), id("a2"))),
    { k: "if", test: bin("!==", id("r0"), id("r1")), then: [{ k: "break", label: "L0" }], else: [] },
    exprStmt(assignExpr(id("r0"), lit('"x"'))),
  ];
  const v = classifySite(before, before, 0, "r0", id("a2"));
  assert.deepEqual(v, { ok: false, reason: "use-under-control-flow" });
});

test("if-chain regression companion: the same consumer without the jump still folds (R1a)", () => {
  const before: Stmt[] = [
    exprStmt(assignExpr(id("r0"), id("a2"))),
    { k: "if", test: bin("!==", id("r0"), id("r1")), then: [exprStmt(assignExpr(id("r3"), lit("1")))], else: [] },
    exprStmt(assignExpr(id("r0"), lit('"x"'))),
  ];
  const v = classifySite(before, before, 0, "r0", id("a2"));
  assert.deepEqual(v, { ok: true, rule: "R1a", j: 1 });
});
