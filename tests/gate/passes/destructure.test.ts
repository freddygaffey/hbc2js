// docs/specs/passes/16-destructure.md — M5 rung 16. Unit tests on hand-built
// ASTs (positives: direct-commit array, staged-commit array with a default
// object property, object rest; negatives: a 2-arg `copyDataProperties`
// (spread-rest's own shape), a `__pc`-tracked run, a plain-reads-only object
// run; a mutation the `check` must reject) plus fixture-level, rung-owned
// assertions on 37/38/39 (docs/CONSOLIDATION.md §B item 7: no exact-output
// comparison against a shared fixture's whole decompiled text — every
// fixture assertion below is a structural/regex check on the rung's own
// effect, never a literal-string template).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { printProgram } from "../../../src/emit/print.ts";
import { check } from "../../../src/passes/destructure/check.ts";
import { destructure } from "../../../src/passes/destructure/index.ts";
import { match } from "../../../src/passes/destructure/match.ts";
import type { PassContext } from "../../../src/passes/types.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

// ---------------------------------------------------------------------------
// Hand-built-AST helpers — the real idiom (spec §2).
// ---------------------------------------------------------------------------

const id = (name: string): Expr => ({ k: "ident", name });
const lit = (text: string): Expr => ({ k: "lit", text });
const UNDEF = lit("undefined");
const call = (callee: string, args: readonly Expr[]): Expr => ({ k: "call", callee: id(callee), args });
const asg = (target: Expr, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target, value } });
const mem = (obj: Expr, i: number): Expr => ({ k: "member", obj, prop: lit(String(i)), computed: true });
const brk = (label: string): Stmt => ({ k: "break", label });
const ifBreak = (test: Expr, label: string): Stmt => ({ k: "if", test, then: [brk(label)], else: [] });
const labeled = (label: string, body: readonly Stmt[]): Stmt => ({ k: "labeled", label, body });
const ret = (arg: Expr): Stmt => ({ k: "return", arg });
const ctx = { functionIndex: 0 } as PassContext;

/** `firstTwo([p, q]) { return p + ":" + q; }` — direct commit, no defaults,
 *  no holes, no rest (spec §2.1(a), the observed `37` shape). */
function firstTwoBody(): readonly Stmt[] {
  const L0 = labeled("L0", [
    asg(id("r6"), UNDEF),
    asg(id("__t"), call("__hbc_iterBegin", [id("a1")])),
    asg(id("r0"), mem(id("__t"), 0)),
    asg(id("r4"), mem(id("__t"), 1)),
    asg(id("__t"), call("__hbc_iterNext", [id("r0"), id("r4")])),
    asg(id("r1"), mem(id("__t"), 0)),
    asg(id("r0"), mem(id("__t"), 1)),
    asg(id("r3"), { k: "bin", op: "===", left: id("r0"), right: id("r6") }),
    asg(id("r2"), UNDEF),
    ifBreak(id("r3"), "L0"),
    asg(id("r2"), id("r1")),
    brk("L0"),
  ]);
  const L1 = labeled("L1", [
    asg(id("r1"), UNDEF),
    ifBreak(id("r3"), "L1"),
    asg(id("__t"), call("__hbc_iterNext", [id("r0"), id("r4")])),
    asg(id("r5"), mem(id("__t"), 0)),
    asg(id("r0"), mem(id("__t"), 1)),
    asg(id("r4"), id("r0")),
    asg(id("r4"), { k: "bin", op: "===", left: id("r4"), right: id("r6") }),
    asg(id("r1"), UNDEF),
    asg(id("r3"), id("r4")),
    ifBreak(id("r4"), "L1"),
    asg(id("r1"), id("r5")),
    asg(id("r3"), id("r4")),
    brk("L1"),
  ]);
  const L2 = labeled("L2", [ifBreak(id("r3"), "L2"), { k: "expr", expr: call("__hbc_iterClose", [id("r0"), lit("false")]) }, brk("L2")]);
  const tail = asg(id("r0"), { k: "bin", op: "+", left: { k: "bin", op: "+", left: id("r2"), right: lit('":"') }, right: id("r1") });
  return [L0, L1, L2, tail, ret(id("r0"))];
}

/** `greet({ name, greeting = 'Hello' } = {}) { ... }` — one plain read then
 *  a defaulted property, both off the same `rSrc` (spec §2.5, `38`'s real
 *  shape). `rSrc` reuses its own register as the guarded property's target,
 *  the source-clobbered exception (§4 precondition 9). */
function greetBody(): readonly Stmt[] {
  const L1 = labeled("L1", [asg(id("r1"), { k: "member", obj: id("r2"), prop: lit('"name"'), computed: false }), asg(id("r2"), { k: "member", obj: id("r2"), prop: lit('"greeting"'), computed: false }), ifBreak({ k: "bin", op: "!==", left: id("r2"), right: id("r3") }, "L1"), asg(id("r2"), id("r0")), brk("L1")]);
  const tail = asg(id("r1"), { k: "bin", op: "+", left: { k: "bin", op: "+", left: id("r2"), right: lit('", "') }, right: id("r1") });
  return [{ k: "expr", expr: { k: "assign", target: id("r0"), value: lit('"Hello"') } }, L1, tail, ret(id("r1"))];
}

/** `{ x, ...others } = src` — object rest, the 3-arg `copyDataProperties`
 *  form this rung owns (2-arg is `spread-rest`'s object spread, spec §7). */
function objectRestBody(): readonly Stmt[] {
  return [asg(id("r2"), { k: "member", obj: id("r5"), prop: lit('"x"'), computed: false }), asg(id("r4"), { k: "object", props: [] }), asg({ k: "member", obj: id("r4"), prop: lit('"x"'), computed: false }, lit("0")), asg(id("r6"), call("__hbc_b_copyDataProperties", [{ k: "object", props: [] }, id("r5"), id("r4")])), ret(id("r2"))];
}

// ---------------------------------------------------------------------------
// Positives.
// ---------------------------------------------------------------------------

test("destructure: direct-commit array pattern -> [r2, r1] = a1", () => {
  const body = firstTwoBody();
  const m = match(body, { ...ctx, fnBody: body });
  assert.notEqual(m, null);
  const rewritten = destructure.rewrite(m!, ctx);
  assert.equal(rewritten.length, 3); // one destructure stmt + tail + return
  const stmt = rewritten[0]!;
  assert.equal(stmt.k, "expr");
  assert.equal((stmt as Extract<Stmt, { k: "expr" }>).expr.k, "destructure");
  const printed = printProgram(rewritten);
  assert.match(printed, /\[r2, r1\] = a1;/);
  const res = check(body, rewritten, { ...ctx, fnBody: body });
  assert.equal(res.ok, true, JSON.stringify(res));
});

test("destructure: object pattern with a leading plain read and a defaulted property", () => {
  const body = greetBody();
  const m = match(body, { ...ctx, fnBody: body });
  assert.notEqual(m, null);
  const rewritten = destructure.rewrite(m!, ctx);
  const printed = printProgram(rewritten);
  assert.match(printed, /\(\{name: r1, greeting: r2 = r0\} = r2\);/);
  const res = check(body, rewritten, { ...ctx, fnBody: body });
  assert.equal(res.ok, true, JSON.stringify(res));
});

test("destructure: object rest (3-arg copyDataProperties)", () => {
  const body = objectRestBody();
  const m = match(body, { ...ctx, fnBody: body });
  assert.notEqual(m, null);
  const rewritten = destructure.rewrite(m!, ctx);
  const printed = printProgram(rewritten);
  assert.match(printed, /\.\.\.r6/);
  const res = check(body, rewritten, { ...ctx, fnBody: body });
  assert.equal(res.ok, true, JSON.stringify(res));
});

// ---------------------------------------------------------------------------
// Negatives.
// ---------------------------------------------------------------------------

test("destructure: refuses a 2-arg copyDataProperties (spread-rest's object spread)", () => {
  const body: readonly Stmt[] = [asg(id("r6"), call("__hbc_b_copyDataProperties", [{ k: "object", props: [] }, id("r5")])), ret(id("r6"))];
  assert.equal(match(body, { ...ctx, fnBody: body }), null);
});

test("destructure: refuses a run containing a __pc write (pc-tracked-region)", () => {
  const body = firstTwoBody().slice();
  const L0 = body[0] as Extract<Stmt, { k: "labeled" }>;
  const withPc = { ...L0, body: [asg(id("__pc"), lit("0")), ...L0.body] };
  const patched = [withPc, ...body.slice(1)];
  assert.equal(match(patched, { ...ctx, fnBody: patched }), null);
});

test("destructure: refuses a plain-reads-only object run (no default, no rest)", () => {
  const body: readonly Stmt[] = [asg(id("r1"), { k: "member", obj: id("r5"), prop: lit('"x"'), computed: false }), asg(id("r2"), { k: "member", obj: id("r5"), prop: lit('"y"'), computed: false }), ret(id("r1"))];
  assert.equal(match(body, { ...ctx, fnBody: body }), null);
});

test("destructure: check rejects a mutated rewrite (wrong element order)", () => {
  const body = firstTwoBody();
  const m = match(body, { ...ctx, fnBody: body });
  assert.notEqual(m, null);
  const rewritten = destructure.rewrite(m!, ctx);
  const stmt = rewritten[0] as Extract<Stmt, { k: "expr" }>;
  const d = stmt.expr as Extract<Expr, { k: "destructure" }>;
  const pattern = d.pattern as Extract<typeof d.pattern, { k: "parr" }>;
  const swapped = { ...d, pattern: { ...pattern, elements: [...pattern.elements].reverse() } };
  const mutated = [{ ...stmt, expr: swapped }, ...rewritten.slice(1)];
  const res = check(body, mutated, { ...ctx, fnBody: body });
  assert.equal(res.ok, false);
});

test("destructure: check rejects a mutated rewrite (wrong object key)", () => {
  const body = greetBody();
  const m = match(body, { ...ctx, fnBody: body });
  assert.notEqual(m, null);
  const rewritten = destructure.rewrite(m!, ctx);
  const idx = rewritten.findIndex((s) => s.k === "expr" && s.expr.k === "destructure");
  const stmt = rewritten[idx] as Extract<Stmt, { k: "expr" }>;
  const d = stmt.expr as Extract<Expr, { k: "destructure" }>;
  const pattern = d.pattern as Extract<typeof d.pattern, { k: "pobj" }>;
  const props = pattern.props.map((p) => (p.key === "name" ? { ...p, key: "wrongKey" } : p));
  const mutated = rewritten.map((s, i) => (i === idx ? { ...stmt, expr: { ...d, pattern: { ...pattern, props } } } : s));
  const res = check(body, mutated, { ...ctx, fnBody: body });
  assert.equal(res.ok, false);
});

// ---------------------------------------------------------------------------
// Fixture-level, rung-owned assertions (no exact-output comparison).
// ---------------------------------------------------------------------------

function decompileFixture(name: string, version: string): string {
  const hbc = join(repoRoot(), "tests/fixtures/constructs", name, `${version}.hbc`);
  return decompile(readFileSync(hbc)).code;
}

for (const version of ["v94", "v99"]) {
  test(`destructure: 37-destructuring-array (${version}) — firstTwo becomes a destructuring assignment`, () => {
    const code = decompileFixture("37-destructuring-array", version);
    assert.match(code, /\[\w+, \w+\] = \w+;/);
  });

  test(`destructure: 38-destructuring-object (${version}) — greet becomes a destructuring assignment`, () => {
    const code = decompileFixture("38-destructuring-object", version);
    // Rung-owned: the object pattern appears (`greeting: … = …` renamed
    // property with its default folded in) and the per-property `GetById`
    // fan-out it replaced is gone from that function — never an assertion
    // on the *whole* file's text, and tolerant of `fn-naming`'s own (pre-
    // existing, unrelated) orphan-naming gap at v99 (docs/BUGS.md).
    assert.match(code, /\(\{name: \w+, greeting: \w+ = [^,}]+\} = \w+\);/);
  });

  test(`destructure: 39-destructuring-params (${version}) — makeUser becomes a destructuring assignment`, () => {
    const code = decompileFixture("39-destructuring-params", version);
    assert.match(code, /\(\{id: \w+, name: \w+ = .*?, tags: \w+ = new Array\(0\)\} = \w+\);/);
  });
}
