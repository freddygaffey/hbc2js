// docs/specs/passes/15-default-params.md, corrected per docs/PUSHBACK.md P-8
// (the real idiom is a labeled block with a tail `break`, not an if/else —
// see `src/passes/default-params/match.ts`'s header comment). Unit tests on
// hand-built ASTs (positives, negatives, a `check` refusal, a mutation the
// checker must reject) plus fixture-level, rung-owned assertions on
// `51-default-params`/`39-destructuring-params` (positive) and
// `42-rest-params` (negative — no defaults, must be left untouched). No
// exact-output comparison against a shared fixture's whole decompiled text
// (docs/CONSOLIDATION.md §B item 7): every fixture assertion below is a
// structural/regex check on the rung's own effect (param list shape,
// residual `arguments[k]` reads), never a literal-string template.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Param, Stmt } from "../../../src/emit/ast.ts";
import { p } from "../../../src/emit/ast.ts";
import { check } from "../../../src/passes/default-params/check.ts";
import { defaultParams } from "../../../src/passes/default-params/index.ts";
import { classifyFunc, rewriteList } from "../../../src/passes/default-params/match.ts";
import type { FuncLike } from "../../../src/passes/default-params/match.ts";
import { match } from "../../../src/passes/default-params/match.ts";
import type { PassContext } from "../../../src/passes/types.ts";

// ---------------------------------------------------------------------------
// Hand-built-AST helpers — the real idiom (P-8): a labeled block per default,
// tail `break`, guard `if` in the *middle*, not the last statement.
// ---------------------------------------------------------------------------

const id = (name: string): Expr => ({ k: "ident", name });
const lit = (text: string): Expr => ({ k: "lit", text });
const UNDEF: Expr = lit("undefined");
const bin = (op: "!==" | "+" | "*", left: Expr, right: Expr): Expr => ({ k: "bin", op, left, right });
const assign = (target: Expr, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target, value } });
const argAt = (k: number): Expr => ({ k: "member", obj: { k: "argumentsObject" }, prop: lit(String(k)), computed: true });
const brk = (label: string): Stmt => ({ k: "break", label });
const guardIf = (rX: string, u: Expr, label: string): Stmt => ({ k: "if", test: bin("!==", id(rX), u), then: [brk(label)], else: [] });
const labeled = (label: string, body: readonly Stmt[]): Stmt => ({ k: "labeled", label, body });
const decl = (names: readonly string[]): Stmt => ({ k: "decl", kind: "let", names });
const ret = (arg: Expr | null): Stmt => ({ k: "return", arg });
const ctx = {} as PassContext;

/** `greet(a1, greeting = 'Hello, ' + a1 + '!')` — a single default reading a
 *  declared param, with a one-shot local temp (`r1`, the literal `"!"`, read
 *  once right after it's produced) — the shape that needs `collapseToIife`
 *  the moment the temp is *not* a pure literal (`withSideEffectDefault`
 *  below), and is exercised here at its simplest. */
function greetFunc(): FuncLike {
  const body: Stmt[] = [
    decl(["r0", "r1"]),
    labeled("L0", [assign(id("r0"), argAt(1)), assign(id("r1"), UNDEF), guardIf("r0", id("r1"), "L0"), assign(id("r1"), lit('"!"')), assign(id("r0"), bin("+", bin("+", lit('"Hello, "'), id("a1")), id("r1"))), brk("L0")]),
    ret(id("r0")),
  ];
  return { name: "greet", params: [p("a1")], body };
}

/** `chainedDefaults(a = 1, b = a + 1, c = a + b)` — v94's bunched-load style:
 *  every default's own `arguments[k]` load, plus the shared literal prologue
 *  constant `r4 = 1`, sit inside `L0` even though `r4` is only read by `L1`'s
 *  default — the exact shape that needs prologue-constant substitution, not
 *  block deletion, to stay sound. */
function chainedFunc(): FuncLike {
  const body: Stmt[] = [
    decl(["r0", "r1", "r2", "r3", "r4"]),
    labeled("L0", [assign(id("r0"), argAt(0)), assign(id("r3"), argAt(1)), assign(id("r1"), argAt(2)), assign(id("r4"), lit("1")), assign(id("r2"), UNDEF), guardIf("r0", id("r2"), "L0"), assign(id("r0"), id("r4")), brk("L0")]),
    labeled("L1", [guardIf("r3", id("r2"), "L1"), assign(id("r3"), bin("+", id("r0"), id("r4"))), brk("L1")]),
    labeled("L2", [guardIf("r1", id("r2"), "L2"), assign(id("r1"), bin("+", id("r0"), id("r3"))), brk("L2")]),
    ret(id("r0")),
  ];
  return { name: "chainedDefaults", params: [], body };
}

// ---------------------------------------------------------------------------
// Unit tests: classifyFunc (positives, negatives).
// ---------------------------------------------------------------------------

test("default-params: classifyFunc accepts a single default reading a declared param, with a one-shot local temp", () => {
  const [d, ...rest] = classifyFunc(greetFunc()).defaults;
  assert.equal(rest.length, 0);
  assert.equal(d?.k, 1);
  assert.equal(d?.rX, "r0");
  // The temp `r1` is not a pure-literal-substitutable constant used *only*
  // elsewhere (it's read right after it's produced, inside this very
  // default) — F5's `collapseToIife` path: an immediately-invoked function
  // expression, never a bare register read with no legal scope.
  assert.equal(d?.init.k, "call");
});

test("default-params: classifyFunc folds a prologue constant shared by a later default (chainedDefaults' `r4`), never a dangling register", () => {
  const { defaults } = classifyFunc(chainedFunc());
  assert.equal(defaults.length, 3);
  assert.deepEqual(
    defaults.map((d) => d.k),
    [0, 1, 2],
  );
  assert.deepEqual(defaults[0]!.init, lit("1"), "default 0's own body, `r0 = r4`, folds to the literal 1");
  // Default 1's `r3 = r0 + r4` must fold r4 to the literal, not leave a bare
  // `r4` behind — `r4`'s own assignment lived inside `L0`, which this
  // rewrite deletes.
  const wantB = bin("+", id("r0"), lit("1"));
  assert.deepEqual(defaults[1]!.init, wantB);
});

test("default-params: classifyFunc stops (yields a shorter prefix, not a refusal) at an out-of-order guard", () => {
  // Only `L1` (k=1) present, no `L0` — `k !== next` (0) the first time.
  const body: Stmt[] = [labeled("L0", [assign(id("r0"), argAt(1)), assign(id("r1"), UNDEF), guardIf("r0", id("r1"), "L0"), assign(id("r0"), lit("2")), brk("L0")])];
  const F: FuncLike = { name: "f", params: [], body };
  assert.deepEqual(classifyFunc(F).defaults, []);
});

test("default-params: classifyFunc refuses a guard whose `then` is not a bare tail `break` (D14 polarity: `===` is not this idiom)", () => {
  const body: Stmt[] = [
    labeled("L0", [
      assign(id("r0"), argAt(0)),
      assign(id("r1"), UNDEF),
      { k: "if", test: bin("!==" as const, id("r0"), id("r1")), then: [], else: [brk("L0")] }, // if/else, not the labeled-block idiom
      assign(id("r0"), lit("2")),
      brk("L0"),
    ]),
  ];
  const F: FuncLike = { name: "f", params: [], body };
  assert.deepEqual(classifyFunc(F).defaults, []);
});

test("default-params: classifyFunc refuses a default body that reads unrelated body state", () => {
  const body: Stmt[] = [
    decl(["r0", "r1", "r5"]),
    labeled("L0", [assign(id("r0"), argAt(0)), assign(id("r1"), UNDEF), guardIf("r0", id("r1"), "L0"), assign(id("r0"), id("r5")), brk("L0")]),
    assign(id("r5"), lit("1")),
    ret(id("r0")),
  ];
  const F: FuncLike = { name: "f", params: [], body };
  assert.deepEqual(classifyFunc(F).defaults, [], "r5 is only ever set *after* the prologue — not a prologue constant, not a moved register");
});

// ---------------------------------------------------------------------------
// Unit test: check() is sound — recomputes, and rejects a mutated writer.
// ---------------------------------------------------------------------------

test("default-params: check() accepts the real rewrite and rejects a mutated default expression", () => {
  const F = greetFunc();
  const list: readonly Stmt[] = [{ k: "func", name: F.name!, params: F.params, body: F.body }];
  const m = match(list, ctx);
  assert.ok(m !== null);
  const after = rewriteList(list, m!.data);
  assert.equal(check(list, after, ctx).ok, true);

  // Mutation: swap the recovered default's `init` for a wrong-but-plausible
  // literal (same arity of change a mutated `collapseToIife`/`collapseToInit`
  // could produce) — the checker must refuse it, not silently accept a
  // structurally-different function.
  const funcStmt = after[0] as Extract<Stmt, { k: "func" }>;
  const badParams: readonly Param[] = [funcStmt.params[0]!, { name: funcStmt.params[1]!.name, init: lit('"WRONG"') }];
  const mutated: readonly Stmt[] = [{ ...funcStmt, params: badParams }];
  const verdict = check(list, mutated, ctx);
  assert.equal(verdict.ok, false);
});

test("default-params: check() rejects a before/after pair whose guard polarity was flipped (D14)", () => {
  // `before` has an inverted (`===`) guard — not this idiom at all, so
  // `classifyFunc` finds nothing to justify *any* rewrite of it.
  const body: Stmt[] = [
    decl(["r0", "r1"]),
    labeled("L0", [assign(id("r0"), argAt(0)), assign(id("r1"), UNDEF), { k: "if", test: bin("!==" as const, id("r0"), id("r1")), then: [brk("L0")], else: [] }, assign(id("r0"), lit("2")), brk("L0")]),
    ret(id("r0")),
  ];
  const before: readonly Stmt[] = [{ k: "func", name: "f", params: [], body }];
  const real = rewriteList(before, match(before, ctx)!.data);
  // Now flip the polarity in `before` only, keeping the same `after` a real
  // (non-flipped) rewrite would have produced — `check` must recompute from
  // `before` and refuse, not trust that some `after` happens to look right.
  const flippedTest: Expr = { k: "bin", op: "===", left: id("r0"), right: id("r1") };
  const flippedGuard: Stmt = { k: "if", test: flippedTest, then: [brk("L0")], else: [] };
  const flippedLabeled: Stmt = { k: "labeled", label: "L0", body: [assign(id("r0"), argAt(0)), assign(id("r1"), UNDEF), flippedGuard, assign(id("r0"), lit("2")), brk("L0")] };
  const flippedBody: readonly Stmt[] = [decl(["r0", "r1"]), flippedLabeled, ret(id("r0"))];
  const flippedBefore: readonly Stmt[] = [{ k: "func", name: "f", params: [], body: flippedBody }];
  assert.equal(check(flippedBefore, real, ctx).ok, false);
});

// ---------------------------------------------------------------------------
// Fixture-level, rung-owned assertions (no whole-output comparison).
// ---------------------------------------------------------------------------

const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, "v94.hbc")));

test("default-params: 51-default-params — every one of the four defaulted functions gains a real ES default, no residual guard block", () => {
  const code = decompile(fixtureBytes("51-default-params"), { moduleName: "x" }).code;
  // Rung-owned: the labeled-block idiom (`if (rX !== ...) { break L`) must be
  // fully gone for every one of this fixture's defaults — residual would
  // mean a default the rung should have recovered was left as body code.
  assert.doesNotMatch(code, /!==[^)]*\)\s*\{\s*break L/, "no residual labeled-block default guard should survive");
  // Positive: each function's parameter list now carries a default.
  assert.match(code, /function \w*greet\w*\([^)]*=[^)]*\)/);
  assert.match(code, /function \w*withSideEffectDefault\w*\([^)]*=[^)]*\)/);
  assert.match(code, /function \w*chainedDefaults\w*\([^)]*=[^)]*\)/);
  assert.match(code, /function \w*defaultUsesFunction\w*\([^)]*=[^)]*\)/);
});

test("default-params: 39-destructuring-params — the outer `= {}`/`= []` default is recovered (destructure's own job picks up from there)", () => {
  const code = decompile(fixtureBytes("39-destructuring-params"), { moduleName: "x" }).code;
  assert.match(code, /function \w*makeUser\w*\([^)]*=\s*\{\}[^)]*\)/);
  assert.match(code, /function \w*sumPair\w*\([^)]*=[^)]*\)/);
});

test("default-params: 42-rest-params has no defaults and is left byte-identical with the rung on or off", () => {
  const bytes = fixtureBytes("42-rest-params");
  const withPass = decompile(bytes, { moduleName: "x" }).code;
  const withoutPass = decompile(bytes, { moduleName: "x", passes: { skip: ["default-params"] } }).code;
  assert.equal(withPass, withoutPass);
});

test("default-params: idempotent — classifyFunc finds nothing left in the rung's own output", () => {
  const before = greetFunc();
  const m = match([{ k: "func", name: before.name!, params: before.params, body: before.body }], ctx);
  const rewritten = rewriteList([{ k: "func", name: before.name!, params: before.params, body: before.body }], m!.data)[0] as Extract<Stmt, { k: "func" }>;
  assert.deepEqual(classifyFunc(rewritten).defaults, [], "the rewrite's own output must not match again (PL-08)");
});

test("default-params: registered, catalogued, ordered after expr-rebuild/global-access/call-shape", () => {
  assert.equal(defaultParams.name, "default-params");
  assert.equal(defaultParams.stage, "B");
  assert.deepEqual(defaultParams.catalogue, [24]);
  assert.deepEqual(defaultParams.after, ["expr-rebuild", "global-access", "call-shape"]);
});
