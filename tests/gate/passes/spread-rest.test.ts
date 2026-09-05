// docs/specs/passes/17-spread-rest.md — M5 rung 17. Unit tests on hand-built
// ASTs (positives: S1 array literal with an interleaved spread/plain run, S2
// spread-call, S3 rest parameter, S4 object spread with a seed prop and a
// trailing folded store; negatives: a 3-arg `copyDataProperties` — spec 16's
// object-rest form — a defined-`this` `apply`, two `copyRestArgs` calls in
// one body; a mutation the `check` must reject) plus fixture-level, rung-
// owned assertions on 40/41/42 (docs/CONSOLIDATION.md §B item 7: no exact-
// output comparison against a shared fixture's whole decompiled text).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { printProgram } from "../../../src/emit/print.ts";
import { parses } from "../../../src/passes/ast.ts";
import { check } from "../../../src/passes/spread-rest/check.ts";
import { spreadRest } from "../../../src/passes/spread-rest/index.ts";
import { match } from "../../../src/passes/spread-rest/match.ts";
import type { PassContext } from "../../../src/passes/types.ts";
import { runProgram } from "../../../src/harness/runner.ts";
import { printLines } from "../../../src/harness/trace.ts";
import { repoRoot } from "../../support/paths.ts";

const id = (name: string): Expr => ({ k: "ident", name });
const lit = (text: string): Expr => ({ k: "lit", text });
const call = (callee: string, args: readonly Expr[]): Expr => ({ k: "call", callee: id(callee), args });
const asg = (target: Expr, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target, value } });
const mem = (obj: Expr, key: string, computed = false): Expr => ({ k: "member", obj, prop: computed ? key === "" ? lit("0") : ({ k: "ident", name: key } as Expr) : lit(key), computed });
const ret = (arg: Expr): Stmt => ({ k: "return", arg });
const ctx = { functionIndex: 0 } as PassContext;

// ---------------------------------------------------------------------------
// Hand-built-AST helpers — the real idiom (spec §2/§4).
// ---------------------------------------------------------------------------

/** `r9 = [0]; r9.length = 3; r2 = 1; r1 = arraySpread(r9, r3, r2); r9[r1] = 4;
 *  r9[arraySpread(r9, r3, r1 + r2)] = 5;` — S1, two spreads + interleaved
 *  plain elements, the real `40-spread-array` v94 global shape (§2 H1a). */
function arrayBody(): readonly Stmt[] {
  return [
    asg(id("r3"), { k: "array", elements: [lit("1"), lit("2"), lit("3")] }),
    asg(id("r9"), { k: "array", elements: [lit("0")] }),
    asg(mem(id("r9"), "length"), lit("3")),
    asg(id("r2"), lit("1")),
    asg(id("r1"), call("__hbc_b_arraySpread", [id("r9"), id("r3"), id("r2")])),
    asg({ k: "member", obj: id("r9"), prop: id("r1"), computed: true }, lit("4")),
    asg({ k: "member", obj: id("r9"), prop: call("__hbc_b_arraySpread", [id("r9"), id("r3"), { k: "bin", op: "+", left: id("r1"), right: id("r2") }]), computed: true }, lit("5")),
    ret(id("r9")),
  ];
}

/** `r7 = fn; r1 = new Array(0); arraySpread(r1, r3, 0); r1 = apply(r7, r1,
 *  undefined);` — S2, one spread argument, no register-shuffle. */
function callBody(): readonly Stmt[] {
  return [
    asg(id("r7"), id("fn")),
    asg(id("r1"), { k: "new", callee: id("Array"), args: [lit("0")] }),
    { k: "expr", expr: call("__hbc_b_arraySpread", [id("r1"), id("r3"), lit("0")]) },
    asg(id("r1"), call("__hbc_b_apply", [id("r7"), id("r1"), lit("undefined")])),
    ret(id("r1")),
  ];
}

/** `function f(a1) { return copyRestArgs(arguments, 1).join(","); }` — S3. */
function restFunc(): Stmt {
  return { k: "func", name: "_fn1", params: [{ name: "a1" }], body: [ret({ k: "call", callee: { k: "member", obj: call("__hbc_b_copyRestArgs", [{ k: "argumentsObject" }, lit("1")]), prop: lit("join"), computed: false }, args: [lit('","')] })] };
}

/** `r6 = {x: 1}; copyDataProperties(r6, r2); r6.y = r3;` — S4, a seed prop
 *  and a trailing folded store after the spread. */
function objectBody(): readonly Stmt[] {
  return [asg(id("r6"), { k: "object", props: [{ key: "x", computed: false, value: lit("1") }] }), { k: "expr", expr: call("__hbc_b_copyDataProperties", [id("r6"), id("r2")]) }, asg(mem(id("r6"), "y"), id("r3")), ret(id("r6"))];
}

// ---------------------------------------------------------------------------
// Positives.
// ---------------------------------------------------------------------------

test("spread-rest: S1 array literal with two spreads and interleaved elements", () => {
  const body = arrayBody();
  const m = match(body, { ...ctx, fnBody: body });
  assert.notEqual(m, null);
  assert.equal(m!.data.rule, "array");
  const rewritten = spreadRest.rewrite(m!, ctx);
  const printed = printProgram(rewritten);
  assert.match(printed, /r9 = \[0, \.\.\.r3, 4, \.\.\.r3, 5\];/);
  assert.doesNotMatch(printed, /__hbc_b_arraySpread/);
  const res = check(body, rewritten, { ...ctx, fnBody: body });
  assert.equal(res.ok, true, JSON.stringify(res));
});

test("spread-rest: S2 spread call, single argument, no receiver", () => {
  const body = callBody();
  const m = match(body, { ...ctx, fnBody: body });
  assert.notEqual(m, null);
  assert.equal(m!.data.rule, "call");
  const rewritten = spreadRest.rewrite(m!, ctx);
  const printed = printProgram(rewritten);
  assert.match(printed, /r1 = r7\(\.\.\.r3\);/);
  const res = check(body, rewritten, { ...ctx, fnBody: body });
  assert.equal(res.ok, true, JSON.stringify(res));
});

test("spread-rest: S2 spread call, multiple spread arguments (variadicSum shape)", () => {
  const body: readonly Stmt[] = [
    asg(id("r1"), { k: "new", callee: id("Array"), args: [lit("0")] }),
    asg(id("r13"), id("r1")),
    asg(id("r12"), id("r3")),
    asg(id("r11"), lit("0")),
    asg(id("r11"), call("__hbc_b_arraySpread", [id("r13"), id("r12"), id("r11")])),
    asg(id("r13"), id("r1")),
    asg(id("r12"), id("r9")),
    asg(id("r8"), call("__hbc_b_arraySpread", [id("r13"), id("r12"), id("r11")])),
    asg(id("r13"), id("r7")),
    asg(id("r12"), id("r1")),
    asg(id("r11"), lit("undefined")),
    asg(id("r1"), call("__hbc_b_apply", [id("r13"), id("r12"), id("r11")])),
    ret(id("r1")),
  ];
  const m = match(body, { ...ctx, fnBody: body });
  assert.notEqual(m, null);
  const rewritten = spreadRest.rewrite(m!, ctx);
  const printed = printProgram(rewritten);
  assert.match(printed, /r1 = r7\(\.\.\.r3, \.\.\.r9\);/); // not `...r12, ...r12` — each source resolved at its own call site
  const res = check(body, rewritten, { ...ctx, fnBody: body });
  assert.equal(res.ok, true, JSON.stringify(res));
});

test("spread-rest: S3 rest parameter, k=1 with one declared param", () => {
  const list = [restFunc()];
  const m = match(list, { ...ctx, fnBody: list });
  assert.notEqual(m, null);
  assert.equal(m!.data.rule, "rest");
  const rewritten = spreadRest.rewrite(m!, ctx);
  const printed = printProgram(rewritten);
  assert.match(printed, /function _fn1\(a1, \.\.\.r0\)/);
  assert.doesNotMatch(printed, /__hbc_b_copyRestArgs/);
  const res = check(list, rewritten, { ...ctx, fnBody: list });
  assert.equal(res.ok, true, JSON.stringify(res));
});

test("spread-rest: S3 rest parameter, k=0, no declared params", () => {
  const f: Stmt = { k: "func", name: "_fn4", params: [], body: [ret(call("__hbc_b_copyRestArgs", [{ k: "argumentsObject" }, lit("0")]))] };
  const list = [f];
  const m = match(list, { ...ctx, fnBody: list });
  assert.notEqual(m, null);
  const rewritten = spreadRest.rewrite(m!, ctx);
  assert.match(printProgram(rewritten), /function _fn4\(\.\.\.r0\)/);
  const res = check(list, rewritten, { ...ctx, fnBody: list });
  assert.equal(res.ok, true, JSON.stringify(res));
});

test("spread-rest: S4 object spread with a seed property and a trailing folded store", () => {
  const body = objectBody();
  const m = match(body, { ...ctx, fnBody: body });
  assert.notEqual(m, null);
  assert.equal(m!.data.rule, "object");
  const rewritten = spreadRest.rewrite(m!, ctx);
  const printed = printProgram(rewritten);
  assert.match(printed, /r6 = \{x: 1, \.\.\.r2, y: r3\};/);
  const res = check(body, rewritten, { ...ctx, fnBody: body });
  assert.equal(res.ok, true, JSON.stringify(res));
});

test("spread-rest: H1c (new Array(0), no apply) does not swallow a trailing unrelated statement (regression: 40-spread-array [...str].join('-'))", () => {
  // `r8 = new Array(0); r12 = "abc"; r13 = r8; r11 = 0; r1 = arraySpread(r13,
  // r12, r11); r1 = "-"; r1 = r8.join(r1);` — the real `[...str].join('-')`
  // shape (§2 H1c). `r1 = "-"` *looks* like scratch setup (a bare `rX =
  // <lit>`) but belongs to the unrelated `.join` call that follows, not to
  // the array-building run: consuming it into the deleted range would lose
  // the separator's own value. `matchCall`'s run must end *before* it (only
  // a statement actually read by a recognised call/store may extend the
  // consumed range — `consumedUpTo`), leaving `r1 = "-"` and the `.join`
  // call both present, unmodified, after the rewrite.
  const body: readonly Stmt[] = [
    asg(id("r8"), { k: "new", callee: id("Array"), args: [lit("0")] }),
    asg(id("r12"), lit('"abc"')),
    asg(id("r13"), id("r8")),
    asg(id("r11"), lit("0")),
    asg(id("r1"), call("__hbc_b_arraySpread", [id("r13"), id("r12"), id("r11")])),
    asg(id("r1"), lit('"-"')),
    asg(id("r1"), { k: "call", callee: { k: "member", obj: id("r8"), prop: lit("join"), computed: false }, args: [id("r1")] }),
    ret(id("r1")),
  ];
  const m = match(body, { ...ctx, fnBody: body });
  assert.notEqual(m, null);
  assert.equal(m!.data.rule, "array");
  assert.equal(m!.data.endIndex, 5); // stops right after the arraySpread call, not at 6
  const rewritten = spreadRest.rewrite(m!, ctx);
  const printed = printProgram(rewritten);
  assert.match(printed, /r8 = \[\.\.\."abc"\];/);
  assert.match(printed, /r1 = "-";/); // survives — not absorbed into the deleted run
  assert.match(printed, /r1 = r8\.join\(r1\);/);
  const res = check(body, rewritten, { ...ctx, fnBody: body });
  assert.equal(res.ok, true, JSON.stringify(res));
});

// ---------------------------------------------------------------------------
// Negatives.
// ---------------------------------------------------------------------------

test("spread-rest: refuses a 3-arg copyDataProperties (destructure's object-rest form)", () => {
  const body: readonly Stmt[] = [asg(id("r6"), { k: "object", props: [] }), { k: "expr", expr: call("__hbc_b_copyDataProperties", [id("r6"), id("r2"), id("r4")]) }, ret(id("r6"))];
  assert.equal(match(body, { ...ctx, fnBody: body }), null);
});

test("spread-rest: refuses destructure's inline iterator-rest loop (no __hbc_b_ call at all)", () => {
  const body: readonly Stmt[] = [asg(id("r0"), call("__hbc_iterBegin", [id("a1")])), ret(id("r0"))];
  assert.equal(match(body, { ...ctx, fnBody: body }), null);
});

test("spread-rest: refuses a broken index chain (S1)", () => {
  const body: readonly Stmt[] = [asg(id("r9"), { k: "array", elements: [lit("0")] }), asg(id("r1"), call("__hbc_b_arraySpread", [id("r9"), id("r3"), lit("99")])), ret(id("r9"))];
  assert.equal(match(body, { ...ctx, fnBody: body }), null);
});

test("spread-rest: refuses an apply with a defined `this` (this-not-undefined)", () => {
  const body: readonly Stmt[] = [asg(id("r1"), { k: "new", callee: id("Array"), args: [lit("0")] }), { k: "expr", expr: call("__hbc_b_arraySpread", [id("r1"), id("r3"), lit("0")]) }, asg(id("r1"), call("__hbc_b_apply", [id("fn"), id("r1"), id("rObj")])), ret(id("r1"))];
  assert.equal(match(body, { ...ctx, fnBody: body }), null);
});

test("spread-rest: refuses two copyRestArgs calls in one body (multiple-rest-reads)", () => {
  const f: Stmt = { k: "func", name: "_fnX", params: [], body: [{ k: "expr", expr: call("__hbc_b_copyRestArgs", [{ k: "argumentsObject" }, lit("0")]) }, ret(call("__hbc_b_copyRestArgs", [{ k: "argumentsObject" }, lit("0")]))] };
  const list = [f];
  assert.equal(match(list, { ...ctx, fnBody: list }), null);
});

test("spread-rest: check rejects a mutated rewrite (wrong helper arg — array target swapped)", () => {
  const body = arrayBody();
  const m = match(body, { ...ctx, fnBody: body });
  assert.notEqual(m, null);
  const rewritten = spreadRest.rewrite(m!, ctx) as Stmt[];
  const stmt = rewritten[1] as Extract<Stmt, { k: "expr" }>; // the rebuilt `r9 = […]` seed
  const arr = stmt.expr as Extract<Expr, { k: "assign" }>;
  const value = arr.value as Extract<Expr, { k: "array" }>;
  // Mutate: swap the two spread sources' order (semantically wrong — the
  // second `...r3` block should append *after* `4`, not before it).
  const mutatedElements = [value.elements[0]!, value.elements[2]!, value.elements[1]!, value.elements[3]!, value.elements[4]!];
  const mutated = rewritten.map((s, i) => (i === 1 ? { ...stmt, expr: { ...arr, value: { ...value, elements: mutatedElements } } } : s));
  const res = check(body, mutated, { ...ctx, fnBody: body });
  assert.equal(res.ok, false);
});

test("spread-rest: check rejects a spread rewritten as a non-spread element (wrong helper form)", () => {
  const body = callBody();
  const m = match(body, { ...ctx, fnBody: body });
  assert.notEqual(m, null);
  const rewritten = spreadRest.rewrite(m!, ctx) as Stmt[];
  const idx = rewritten.findIndex((s) => s.k === "expr" && s.expr.k === "assign" && s.expr.value.k === "call");
  const stmt = rewritten[idx] as Extract<Stmt, { k: "expr" }>;
  const assign = stmt.expr as Extract<Expr, { k: "assign" }>;
  const callExpr = assign.value as Extract<Expr, { k: "call" }>;
  // Mutate: the spread argument becomes a plain (non-spread) reference —
  // `r7(r3)` instead of `r7(...r3)`, silently changing arity-1-iteration
  // into a single-value call.
  const mutatedArgs = callExpr.args.map((a) => (a.k === "spread" ? a.arg : a));
  const mutated = rewritten.map((s, i) => (i === idx ? { ...stmt, expr: { ...assign, value: { ...callExpr, args: mutatedArgs } } } : s));
  const res = check(body, mutated, { ...ctx, fnBody: body });
  assert.equal(res.ok, false);
});

// `stage-b-per-site-parses` (docs/BUGS.md): a per-site `parses(after)` call
// used to refuse a site the instant its enclosing statement list also held
// an untouched bare `break`/`continue` — legal in the real function (an
// enclosing loop/switch this list-level check never sees), illegal only
// because `parses` wraps *this list alone* standalone. Prepending one such
// statement, untouched by the rewrite, must not change the verdict.
test("spread-rest: check does not refuse a site whose enclosing list also holds an untouched bare `break`", () => {
  const bareBreak: Stmt = { k: "break", label: null };
  const body = [bareBreak, ...arrayBody()];
  const m = match(body, { ...ctx, fnBody: body });
  assert.notEqual(m, null);
  const rewritten = spreadRest.rewrite(m!, ctx);
  // The bug this guards: printing `rewritten` alone (as this per-site
  // checker used to) is not valid JS on its own — proof the fix is not
  // vacuous.
  assert.equal(parses(rewritten), false);
  const res = check(body, rewritten, { ...ctx, fnBody: body });
  assert.equal(res.ok, true, JSON.stringify(res));
});

// ---------------------------------------------------------------------------
// Fixture-level, rung-owned assertions (no exact-output comparison).
// ---------------------------------------------------------------------------

function decompileFixture(name: string, version: string): string {
  const hbc = join(repoRoot(), "tests/fixtures/constructs", name, `${version}.hbc`);
  return decompile(readFileSync(hbc)).code;
}

function helperCallCount(code: string): number {
  // Exclude the prelude's own `function __hbc_b_foo(...) { ... }`
  // definitions — only count actual *call* sites.
  const lines = code.split("\n").filter((l) => !/^\s*function __hbc_b_/.test(l));
  const m = lines.join("\n").match(/__hbc_b_(arraySpread|apply|copyRestArgs|copyDataProperties)\(/g);
  return m === null ? 0 : m.length;
}

for (const version of ["v94", "v96", "v99"]) {
  test(`spread-rest: 40-spread-array (${version}) — every array/call spread recovered, no helper calls left`, () => {
    const code = decompileFixture("40-spread-array", version);
    assert.match(code, /\[0, \.\.\.\w+, 4, \.\.\.\w+, 5\]/);
    assert.match(code, /\w+\(\.\.\.\w+\)/); // sum3(...a)
    // Only the prelude's own `function __hbc_b_arraySpread(...) { ... }`
    // definitions may remain — zero *call* sites at every version. v99 used to
    // keep one: `variadicSum` was emitted as a module-level orphan there, so S3
    // could not reach its own `copyRestArgs` call. F24-5 places a capture-nothing
    // function inside the function that creates it, which is the "prove fixed"
    // condition of docs/BUGS.md's 2026-09-02 spread-rest orphan row.
    assert.equal(helperCallCount(code), 0);
  });

  test(`spread-rest: 41-spread-object (${version}) — every object spread recovered, no helper calls left`, () => {
    const code = decompileFixture("41-spread-object", version);
    assert.match(code, /\{\.\.\.\w+, \.\.\.\w+\}/);
    assert.equal(helperCallCount(code), 0);
  });
}

// v98/v99: docs/BUGS.md's 2026-09-02 "spread-rest v98/v99 orphan" row, FIXED by
// F24-5 — S3 could not reach an orphaned function's own `func` node, so
// `combine`'s and `restOnly`'s rest params stayed unrewritten at v98/v99 while
// S1/S2/S4 were unaffected. Both functions capture nothing and are created in
// fn#0, so they are now declared there and S3 reaches them.
test("spread-rest: 42-rest-params (v94) — every rest param recovered, no helper calls left", () => {
  const code = decompileFixture("42-rest-params", "v94");
  assert.match(code, /function \w+\(a1, \.\.\.\w+\)/); // combine
  assert.match(code, /function \w+\(\.\.\.\w+\)/); // restOnly
  assert.equal(helperCallCount(code), 0);
});

for (const version of ["v98", "v99"]) {
  test(`spread-rest: 42-rest-params (${version}) — the former orphan-function gap is closed (F24-5)`, () => {
    const code = decompileFixture("42-rest-params", version);
    // `mutateParamAffectsArguments`'s plain `arguments[0]` use is untouched.
    assert.match(code, /arguments\[0\]/);
    assert.match(code, /function \w+\(a1, \.\.\.\w+\)/); // combine
    assert.match(code, /function \w+\(\.\.\.\w+\)/); // restOnly
    assert.equal(helperCallCount(code), 0);
  });
}

// ---------------------------------------------------------------------------
// Regression: fuzz family F1 (docs/reports/2026-09-04-fuzz-families.md).
//
// Hermes stages a spread's source and index registers once and reuses them at
// the *next* spread site. The matcher used to absorb those staging writes into
// its `Subst` map and `rewrite` then deleted them with the rest of the run, so
// the second site read a register nothing ever assigned (`[...r8]`,
// `copy.push(r0)`), and a plain element stored after a spread kept its raw
// staging register instead of the resolved value. `check.ts` cannot see it: a
// deleted register move has no entry in `effectSequence`.
//
// Behavioural assertion (not an output-text comparison): the decompiled
// program must print what the fixture prints. Verified to FAIL on every one of
// these four versions before the fix and PASS after.
for (const version of [84, 94, 96, 99]) {
  test(`spread-rest: a shared staging register survives two spread sites (adversarial 44, v${version})`, async () => {
    const dir = join(repoRoot(), "tests", "fixtures", "adversarial", "44-fuzz-spread-shared-register");
    const bytes = new Uint8Array(readFileSync(join(dir, `v${version}.hbc`)));
    const js = decompile(bytes, { resolveV98Ambiguity: true, moduleName: "44-fuzz-spread-shared-register" }).code;
    const tmp = mkdtempSync(join(tmpdir(), "hbc2js-spread-rest-"));
    try {
      const candidatePath = join(tmp, "candidate.js");
      writeFileSync(candidatePath, js);
      const run = await runProgram(candidatePath, { timeout: 10000 });
      const expected = readFileSync(join(dir, "expected.txt"), "utf8").trimEnd().split("\n");
      assert.deepEqual(printLines(run.records), expected, `decompiled v${version} diverges from the fixture's own output — a spread site's staging register was deleted while still live`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
