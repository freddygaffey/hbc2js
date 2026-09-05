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

/** `[a = 0] = a1` — one defaulted array element, prologue-fused (§2.2's
 *  2-level nesting for element 0: no earlier element to early-skip for, so
 *  `Ld`/`Ls` collapse into one block; `sumPair`'s real element-0 shape, minus
 *  the second, chained element — that combination is covered by the
 *  fixture-level tests below). */
function oneDefaultArrayBody(): readonly Stmt[] {
  const L2 = labeled("L2", [
    asg(id("__t"), call("__hbc_iterBegin", [id("a1")])),
    asg(id("r0"), mem(id("__t"), 0)),
    asg(id("r4"), mem(id("__t"), 1)),
    asg(id("__t"), call("__hbc_iterNext", [id("r0"), id("r4")])),
    asg(id("r1"), mem(id("__t"), 0)),
    asg(id("r0"), mem(id("__t"), 1)),
    asg(id("r3"), { k: "bin", op: "===", left: id("r0"), right: id("r6") }),
    ifBreak(id("r3"), "L2"),
    ifBreak({ k: "bin", op: "!==", left: id("r1"), right: id("r6") }, "L1"),
    brk("L2"),
  ]);
  const L1 = labeled("L1", [L2, asg(id("r1"), lit("0")), brk("L1")]);
  const L3 = labeled("L3", [ifBreak(id("r3"), "L3"), { k: "expr", expr: call("__hbc_iterClose", [id("r0"), lit("false")]) }, brk("L3")]);
  return [asg(id("r6"), UNDEF), L1, L3, ret(id("r1"))];
}

/** `{ x, ...others } = src` — object rest, the 3-arg `copyDataProperties`
 *  form this rung owns (2-arg is `spread-rest`'s object spread, spec §7). */
function objectRestBody(): readonly Stmt[] {
  return [asg(id("r2"), { k: "member", obj: id("r5"), prop: lit('"x"'), computed: false }), asg(id("r4"), { k: "object", props: [] }), asg({ k: "member", obj: id("r4"), prop: lit('"x"'), computed: false }, lit("0")), asg(id("r6"), call("__hbc_b_copyDataProperties", [{ k: "object", props: [] }, id("r5"), id("r4")])), ret(id("r2"))];
}

/** `skipMiddle(xs) { let a, c; [a, , c] = xs; return a + ':' + c; }` — a
 *  middle hole (§2.3, BUGS.md 2026-09-02), staged-commit throughout:
 *  transcribed verbatim (register names included) from the real v94 lowering
 *  of `65-destructure-hole-rest`'s `skipMiddle`, measured with `--no-pass
 *  var-naming --no-pass fn-naming --no-pass destructure`. `L1` (the middle
 *  position) stages its own value into `r5` but is never committed by `L2`
 *  (which resets `r5` fresh instead of reading it) — the elision. `L3`, the
 *  close block, carries the *final* position's commit at its own head
 *  (`r3 = r5;`), the shape that previously had no fixture (`firstTwo`'s last
 *  element always committed directly inside its own block). */
function skipMiddleBody(): readonly Stmt[] {
  const L0 = labeled("L0", [
    asg(id("r8"), UNDEF),
    asg(id("r4"), UNDEF),
    asg(id("r3"), UNDEF),
    asg(id("__t"), call("__hbc_iterBegin", [id("a1")])),
    asg(id("r1"), mem(id("__t"), 0)),
    asg(id("r6"), mem(id("__t"), 1)),
    asg(id("r5"), UNDEF),
    asg(id("__t"), call("__hbc_iterNext", [id("r1"), id("r6")])),
    asg(id("r7"), mem(id("__t"), 0)),
    asg(id("r1"), mem(id("__t"), 1)),
    asg(id("r9"), { k: "bin", op: "===", left: id("r1"), right: id("r8") }),
    asg(id("r2"), id("r9")),
    ifBreak(id("r9"), "L0"),
    asg(id("r5"), id("r7")),
    brk("L0"),
  ]);
  // L1: the elided middle position -- stages `r5` but the value is never
  // read by L2 (dead: §2.3's "no following commit read").
  const L1 = labeled("L1", [
    asg(id("r4"), id("r5")), // commit of L0's own stage into 'a's real register
    asg(id("r5"), UNDEF),
    asg(id("r7"), id("r2")), // §2.6 flag-copy before the early guard
    ifBreak(id("r7"), "L1"),
    asg(id("__t"), call("__hbc_iterNext", [id("r1"), id("r6")])),
    asg(id("r7"), mem(id("__t"), 0)),
    asg(id("r1"), mem(id("__t"), 1)),
    asg(id("r9"), id("r1")),
    asg(id("r9"), { k: "bin", op: "===", left: id("r9"), right: id("r8") }),
    asg(id("r2"), id("r9")),
    ifBreak(id("r9"), "L1"),
    asg(id("r5"), id("r7")), // hole's own raw value, staged, never committed
    brk("L1"),
  ]);
  const L2 = labeled("L2", [
    asg(id("r5"), UNDEF),
    asg(id("r7"), id("r2")),
    ifBreak(id("r7"), "L2"),
    asg(id("__t"), call("__hbc_iterNext", [id("r1"), id("r6")])),
    asg(id("r6"), mem(id("__t"), 0)),
    asg(id("r1"), mem(id("__t"), 1)),
    asg(id("r7"), id("r1")),
    asg(id("r7"), { k: "bin", op: "===", left: id("r7"), right: id("r8") }),
    asg(id("r2"), id("r7")),
    ifBreak(id("r7"), "L2"),
    asg(id("r5"), id("r6")),
    brk("L2"),
  ]);
  const L3 = labeled("L3", [
    asg(id("r3"), id("r5")), // close block carries the final position's commit
    asg(id("r5"), id("r2")),
    ifBreak(id("r5"), "L3"),
    { k: "expr", expr: call("__hbc_iterClose", [id("r1"), lit("false")]) },
    brk("L3"),
  ]);
  const tail1 = asg(id("r5"), id("r4"));
  const tail2 = asg(id("r4"), { k: "bin", op: "+", left: id("r5"), right: lit('":"') });
  const tail3 = asg(id("r3"), { k: "bin", op: "+", left: id("r4"), right: id("r3") });
  return [L0, L1, L2, L3, tail1, tail2, tail3, ret(id("r3"))];
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

test("destructure: array pattern with a per-element default (BUGS 2026-09-02) -> [r1 = 0] = a1", () => {
  const body = oneDefaultArrayBody();
  const m = match(body, { ...ctx, fnBody: body });
  assert.notEqual(m, null);
  const rewritten = destructure.rewrite(m!, ctx);
  const printed = printProgram(rewritten);
  assert.match(printed, /\[r1 = 0\] = a1;/);
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

test("destructure: array pattern with a middle hole (BUGS 2026-09-02) -> [r4, , r3] = a1", () => {
  const body = skipMiddleBody();
  const m = match(body, { ...ctx, fnBody: body });
  assert.notEqual(m, null);
  const rewritten = destructure.rewrite(m!, ctx);
  const printed = printProgram(rewritten);
  assert.match(printed, /\[r4, , r3\] = a1;/);
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

test("destructure: check rejects a mutated rewrite (wrong array-element default)", () => {
  const body = oneDefaultArrayBody();
  const m = match(body, { ...ctx, fnBody: body });
  assert.notEqual(m, null);
  const rewritten = destructure.rewrite(m!, ctx);
  const idx = rewritten.findIndex((s) => s.k === "expr" && s.expr.k === "destructure");
  const stmt = rewritten[idx] as Extract<Stmt, { k: "expr" }>;
  const d = stmt.expr as Extract<Expr, { k: "destructure" }>;
  const pattern = d.pattern as Extract<typeof d.pattern, { k: "parr" }>;
  const elements = pattern.elements.map((e) => (e.k === "pel" && e.init !== undefined ? { ...e, init: lit("99") } : e));
  const mutated = rewritten.map((s, i) => (i === idx ? { ...stmt, expr: { ...d, pattern: { ...pattern, elements } } } : s));
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

// BUGS.md 2026-09-02: `sumPair([a = 0, b = 0] = [])`'s array-pattern
// per-element defaults. v84/v94/v96 lower the pattern straight-line (no
// `__pc`/try region — §6's "Abrupt completion" note, `= 0` cannot throw) so
// the matcher now accepts it; v98/v99 wrap the same pattern in a `try`/
// `catch` region instead (measured directly — the matcher's own
// `pc-tracked-region` precondition already refuses it, correctly: this is a
// refusal, not a mis-rewrite, and stays a refusal until batch-4 `try-clean`,
// §8 Q1).
for (const version of ["v84", "v94", "v96"]) {
  test(`destructure: 39-destructuring-params (${version}) — sumPair gets per-element array defaults`, () => {
    const code = decompileFixture("39-destructuring-params", version);
    assert.match(code, /\[\w+ = 0, \w+ = 0\] = \w+;/);
    // The helper *definition* (`function __hbc_iterBegin(src) { ... }`)
    // always prints; only a *call site* (`= __hbc_iterBegin(`) would mean a
    // raw, unrewritten site survived.
    assert.doesNotMatch(code, /= __hbc_iterBegin\(/);
  });
}
for (const version of ["v98", "v99"]) {
  test(`destructure: 39-destructuring-params (${version}) — sumPair's try-wrapped default stays refused`, () => {
    const code = decompileFixture("39-destructuring-params", version);
    assert.match(code, /= __hbc_iterBegin\(/);
  });
}

// BUGS.md 2026-09-02, "still open" part: a hole-by-shape and array rest at
// a function-body-scope site (not `pc-tracked-region`). Measured directly
// (`65-destructure-hole-rest`, `--no-pass var-naming --no-pass fn-naming
// --no-pass destructure` at every version): `skipMiddle`'s `[a, , c] = xs;`
// middle hole lowers straight-line (no `__pc`/try) at v84/v94/v96 -- the
// matcher now accepts it. v98/v99 lower the *same* hole through a
// genuinely different shape (an early-guard flag copy PLUS an `rNextFn`
// alias copy feeding the `iterNext` call directly, never observed on any
// previously-measured fixture) that this rung does not parse; the site
// stays refused (`broken-threading`), not mis-rewritten. `headAndTail`'s
// `[h, ...t] = xs;` rest is refused at *every* version, including function-
// body scope: the append loop's own `try`/`catch` (§2.4) is inherent to the
// rest lowering itself, not a top-level-only artifact of the module
// wrapper's exception machinery as §8 Q1 originally framed it -- confirmed
// by grepping `__pc` inside `headAndTail`'s own printed body at all five
// versions (13 occurrences at v84/v94/v96, 3 at v98/v99, zero of which is
// ever absent). `docs/lowering/destructuring.md` and the BUGS row record
// both measurements.
for (const version of ["v84", "v94", "v96"]) {
  test(`destructure: 65-destructure-hole-rest (${version}) — skipMiddle's middle hole is preserved`, () => {
    const code = decompileFixture("65-destructure-hole-rest", version);
    assert.match(code, /\[\w+, , \w+\] = \w+;/);
  });
}
for (const version of ["v98", "v99"]) {
  test(`destructure: 65-destructure-hole-rest (${version}) — skipMiddle's hole stays refused (different, unhandled shape)`, () => {
    const code = decompileFixture("65-destructure-hole-rest", version);
    assert.doesNotMatch(code, /\[\w+, , \w+\] = \w+;/);
    assert.match(code, /= __hbc_iterBegin\(/);
  });
}
for (const version of ["v84", "v94", "v96", "v98", "v99"]) {
  test(`destructure: 65-destructure-hole-rest (${version}) — headAndTail's rest stays refused (pc-tracked-region, inherent to the append loop)`, () => {
    const code = decompileFixture("65-destructure-hole-rest", version);
    // Never a mis-rewrite: no `...ident] = ` array-rest pattern is ever
    // written, and a raw, unrewritten `__hbc_iterBegin` call site survives
    // (from `headAndTail`; `skipMiddle`'s own call is rewritten away at
    // v84/v94/v96, so this is not double-counting that one).
    assert.doesNotMatch(code, /\.\.\.\w+\] = /);
    assert.match(code, /= __hbc_iterBegin\(/);
  });
}

// BUGS.md 2026-09-02, brief "nested per-element default" measurement
// (2026-09-05): once an array pattern's element is itself a compound
// pattern (a nested array or a nested object, `[a = 1, [b = 2]] = xs` /
// `[{x = 3}] = ys`), Hermes always wraps the whole destructuring in its
// `__pc`-tracked exception region -- confirmed directly at every version,
// with and without a default present, and even in a parameter-default
// position (the inner extraction can throw, so the outer iterator's close
// must be exception-safe). This is the same "inherently pc-tracked" class
// as array rest, not a top-level-only artifact: precondition 6
// (`pc-tracked-region`) already refuses it correctly, so `70` is a pure
// refusal fixture (`--no-pass destructure` is byte-identical to the
// default pipeline) -- see `docs/lowering/destructuring.md` and the BUGS
// row for the measured IR.
for (const version of ["v84", "v94", "v96", "v98", "v99"]) {
  test(`destructure: 70-destructure-nested-default (${version}) — nested array-in-array default stays refused (pc-tracked-region, inherent to the nested extraction)`, () => {
    const code = decompileFixture("70-destructure-nested-default", version);
    // Never a mis-rewrite: no top-level array-destructuring assignment for
    // either function is ever written, and a raw, unrewritten
    // `__hbc_iterBegin` call site survives for both `nestedArrayDefault`
    // and `nestedObjectDefault`.
    assert.doesNotMatch(code, /\[\w+ = 1, \[\w+ = 2\]\] = /);
    assert.doesNotMatch(code, /\[\{x: ?\w+ = 3\}\] = /);
    const calls = code.match(/= __hbc_iterBegin\(/g) ?? [];
    assert.ok(calls.length >= 2, `expected at least 2 unrewritten __hbc_iterBegin call sites, saw ${calls.length}`);
  });

  test(`destructure: 70-destructure-nested-default (${version}) — the destructure pass makes no rewrite on this fixture (pure refusal)`, () => {
    const withPass = decompileFixture("70-destructure-nested-default", version);
    const hbc = join(repoRoot(), "tests/fixtures/constructs/70-destructure-nested-default", `${version}.hbc`);
    const withoutPass = decompile(readFileSync(hbc), { passes: { skip: ["destructure"] } }).code;
    assert.equal(withPass, withoutPass);
  });
}
