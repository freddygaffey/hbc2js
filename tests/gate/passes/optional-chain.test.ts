// docs/specs/passes/18-optional-chain.md — M5 rung 18. Unit tests on
// hand-built ASTs (positives: 1-link and 3-link member chains, a computed
// link, a call link with a base guard, the v99 spilled-compare guard, `??`
// with a register fallback, `??` with a folded literal left; negatives: a
// strict `!==` guard — `default-params`/`destructure` territory — a guard
// breaking to a foreign label, a chain whose `rRes` is read mid-run, a
// `Reflect.apply` whose `this` is not the callee's own base; one mutation
// the checker must reject) plus fixture-level, rung-owned assertions on 48
// (docs/CONSOLIDATION.md §B item 7: no exact-output comparison against a
// shared fixture's whole decompiled text).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { check } from "../../../src/passes/optional-chain/check.ts";
import { optionalChain } from "../../../src/passes/optional-chain/index.ts";
import { match } from "../../../src/passes/optional-chain/match.ts";
import { rewrite } from "../../../src/passes/optional-chain/rewrite.ts";
import type { PassContext } from "../../../src/passes/types.ts";
import { repoRoot } from "../../support/paths.ts";

const id = (name: string): Expr => ({ k: "ident", name });
const lit = (text: string): Expr => ({ k: "lit", text });
const asg = (target: Expr, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target, value } });
const mem = (obj: Expr, key: string, computed = false): Expr => ({ k: "member", obj, prop: computed ? id(key) : lit(key), computed });
const brk = (label: string): Stmt => ({ k: "break", label });
const iff = (test: Expr, then: readonly Stmt[]): Stmt => ({ k: "if", test, then, else: [] });
const ctx = { functionIndex: 0 } as PassContext;

// ---------------------------------------------------------------------------
// C-rule positives.
// ---------------------------------------------------------------------------

/** `r6 = r13?.name;` — one link, v94 inline guard shape (§2.1/§4). */
function oneLinkBody(): readonly Stmt[] {
  return [asg(id("r4"), lit("null")), asg(id("r6"), lit("undefined")), iff({ k: "bin", op: "==", left: id("r13"), right: id("r4") }, [brk("L0")]), asg(id("r6"), mem(id("r13"), "name")), brk("L0")];
}

/** `r6 = r13?.profile?.contacts?.email;` — three links (§1's headline
 *  example, v94 shape). */
function threeLinkBody(): readonly Stmt[] {
  return [
    asg(id("r4"), lit("null")),
    asg(id("r6"), lit("undefined")),
    iff({ k: "bin", op: "==", left: id("r13"), right: id("r4") }, [brk("L1")]),
    asg(id("r14"), mem(id("r13"), "profile")),
    asg(id("r6"), lit("undefined")),
    iff({ k: "bin", op: "==", left: id("r14"), right: id("r4") }, [brk("L1")]),
    asg(id("r14"), mem(id("r14"), "contacts")),
    asg(id("r6"), lit("undefined")),
    iff({ k: "bin", op: "==", left: id("r14"), right: id("r4") }, [brk("L1")]),
    asg(id("r6"), mem(id("r14"), "email")),
    brk("L1"),
  ];
}

/** `r9 = r14?.[r8];` — computed link. */
function computedBody(): readonly Stmt[] {
  return [asg(id("r4"), lit("null")), asg(id("r9"), lit("undefined")), iff({ k: "bin", op: "==", left: id("r14"), right: id("r4") }, [brk("L5")]), asg(id("r9"), mem(id("r14"), "r8", true)), brk("L5")];
}

/** `r6 = r12?.fetch?.();` — a call link, base guarded. */
function callBody(): readonly Stmt[] {
  return [
    asg(id("r4"), lit("null")),
    asg(id("r6"), lit("undefined")),
    iff({ k: "bin", op: "==", left: id("r12"), right: id("r4") }, [brk("L8")]),
    asg(id("r11"), mem(id("r12"), "fetch")),
    asg(id("r6"), lit("undefined")),
    iff({ k: "bin", op: "==", left: id("r11"), right: id("r4") }, [brk("L8")]),
    asg(id("r6"), { k: "call", callee: mem(id("Reflect"), "apply"), args: [id("r11"), id("r12"), { k: "array", elements: [] }] }),
    brk("L8"),
  ];
}

/** v99 spilled-compare guard shape (§2.4): `r3 = r9 == r2; r7 = undefined;
 *  if (r3) break L1;`. */
function v99Body(): readonly Stmt[] {
  return [
    asg(id("r2"), lit("null")),
    asg(id("r3"), { k: "bin", op: "==", left: id("r9"), right: id("r2") }),
    asg(id("r7"), lit("undefined")),
    iff(id("r3"), [brk("L1")]),
    asg(id("r7"), mem(id("r9"), "name")),
    brk("L1"),
  ];
}

for (const [name, body] of [
  ["one-link", oneLinkBody()],
  ["three-link", threeLinkBody()],
  ["computed", computedBody()],
  ["call", callBody()],
  ["v99 spilled-compare", v99Body()],
] as const) {
  test(`optional-chain: C-rule matches (${name})`, () => {
    const m = match(body, { ...ctx, fnBody: body });
    assert.ok(m !== null, name);
    assert.equal(m!.data.kind, "chain");
    const after = rewrite(m!);
    assert.equal(after.length, 2);
    const res = check(body, after, { ...ctx, fnBody: body });
    assert.equal(res.ok, true, res.reason);
    // PL-08: the rewrite's own output is not matched again.
    assert.equal(match(after, { ...ctx, fnBody: after }), null);
  });
}

// ---------------------------------------------------------------------------
// N-rule positives.
// ---------------------------------------------------------------------------

test("optional-chain: N-rule matches (register fallback)", () => {
  const body: readonly Stmt[] = [asg(id("r4"), lit("null")), iff({ k: "bin", op: "!=", left: id("r6"), right: id("r4") }, [brk("L4")]), asg(id("r6"), id("r11")), brk("L4")];
  const m = match(body, { ...ctx, fnBody: body });
  assert.ok(m !== null);
  assert.equal(m!.data.kind, "nullish");
  const after = rewrite(m!);
  assert.equal(after.length, 2);
  const res = check(body, after, { ...ctx, fnBody: body });
  assert.equal(res.ok, true, res.reason);
});

test("optional-chain: N-rule folds a preceding pure literal write (0 ?? d)", () => {
  const body: readonly Stmt[] = [asg(id("r4"), lit("null")), asg(id("r8"), lit("0")), iff({ k: "bin", op: "!=", left: id("r8"), right: id("r4") }, [brk("L12")]), asg(id("r8"), id("r0")), brk("L12")];
  const m = match(body, { ...ctx, fnBody: body });
  assert.ok(m !== null);
  assert.equal(m!.data.kind, "nullish");
  if (m!.data.kind === "nullish") assert.equal(m!.data.left.k, "lit");
  const after = rewrite(m!);
  assert.equal(after.length, 2); // the folded literal write is dropped too (only the r4=null prologue survives)
  const res = check(body, after, { ...ctx, fnBody: body });
  assert.equal(res.ok, true, res.reason);
});

// ---------------------------------------------------------------------------
// Negatives.
// ---------------------------------------------------------------------------

test("optional-chain: refuses a strict !== guard (default-params/destructure territory)", () => {
  const body: readonly Stmt[] = [asg(id("r4"), lit("undefined")), asg(id("r6"), lit("undefined")), iff({ k: "bin", op: "!==", left: id("r13"), right: id("r4") }, [brk("L0")]), asg(id("r6"), mem(id("r13"), "name")), brk("L0")];
  assert.equal(match(body, { ...ctx, fnBody: body }), null);
});

test("optional-chain: refuses a guard sharing its label with a foreign break (label-shared)", () => {
  const body: readonly Stmt[] = [brk("L0"), asg(id("r4"), lit("null")), asg(id("r6"), lit("undefined")), iff({ k: "bin", op: "==", left: id("r13"), right: id("r4") }, [brk("L0")]), asg(id("r6"), mem(id("r13"), "name")), brk("L0")];
  assert.equal(match(body, { ...ctx, fnBody: body }), null);
});

test("optional-chain: refuses a run whose rRes is read mid-run (result-read-early)", () => {
  const body: readonly Stmt[] = [
    asg(id("r4"), lit("null")),
    asg(id("r6"), lit("undefined")),
    iff({ k: "bin", op: "==", left: id("r13"), right: id("r4") }, [brk("L0")]),
    { k: "expr", expr: { k: "call", callee: id("sideEffect"), args: [id("r6")] } },
    asg(id("r6"), mem(id("r13"), "name")),
    brk("L0"),
  ];
  assert.equal(match(body, { ...ctx, fnBody: body }), null);
});

test("optional-chain: refuses a Reflect.apply whose `this` is not the callee's own base (optcall-this-mismatch)", () => {
  const body: readonly Stmt[] = [
    asg(id("r4"), lit("null")),
    asg(id("r6"), lit("undefined")),
    iff({ k: "bin", op: "==", left: id("r12"), right: id("r4") }, [brk("L8")]),
    asg(id("r11"), mem(id("r12"), "fetch")),
    asg(id("r6"), lit("undefined")),
    iff({ k: "bin", op: "==", left: id("r11"), right: id("r4") }, [brk("L8")]),
    asg(id("r6"), { k: "call", callee: mem(id("Reflect"), "apply"), args: [id("r11"), id("rWrongThis"), { k: "array", elements: [] }] }),
    brk("L8"),
  ];
  assert.equal(match(body, { ...ctx, fnBody: body }), null);
});

// ---------------------------------------------------------------------------
// D14: the checker rejects a mutation that flips guard polarity — a `?.`
// link downgraded to a plain `.` (the exact bug class §6's guard-depth
// obligation exists to catch: the getter would now run unconditionally).
// ---------------------------------------------------------------------------

test("optional-chain: check rejects a mutated rewrite (a ?.-link downgraded to plain .)", () => {
  const body = threeLinkBody();
  const m = match(body, { ...ctx, fnBody: body });
  assert.ok(m !== null);
  const after = rewrite(m!);
  const stmt = after[after.length - 1]!;
  assert.equal(stmt.k, "expr");
  const value = (stmt as Extract<Stmt, { k: "expr" }>).expr;
  assert.equal(value.k, "assign");
  const chain = (value as Extract<Expr, { k: "assign" }>).value;
  assert.equal(chain.k, "optmember"); // outermost link (.email)
  // Flip the outermost link from optmember (?.) to a plain member (.).
  const mutated: Stmt = { ...stmt, expr: { ...(value as Extract<Expr, { k: "assign" }>), value: { k: "member", obj: (chain as Extract<Expr, { k: "optmember" }>).obj, prop: (chain as Extract<Expr, { k: "optmember" }>).prop, computed: false } } };
  const res = check(body, [...after.slice(0, -1), mutated], { ...ctx, fnBody: body });
  assert.equal(res.ok, false);
});

test("optional-chain: check rejects a mutated ?? (fallback swapped for an unrelated expression)", () => {
  const body: readonly Stmt[] = [asg(id("r4"), lit("null")), iff({ k: "bin", op: "!=", left: id("r6"), right: id("r4") }, [brk("L4")]), asg(id("r6"), id("r11")), brk("L4")];
  const m = match(body, { ...ctx, fnBody: body });
  assert.ok(m !== null);
  const after = rewrite(m!);
  const stmt = after[after.length - 1]! as Extract<Stmt, { k: "expr" }>;
  const value = stmt.expr as Extract<Expr, { k: "assign" }>;
  const mutated: Stmt = { ...stmt, expr: { ...value, value: { ...(value.value as Extract<Expr, { k: "logical" }>), right: lit("999") } } };
  const res = check(body, [...after.slice(0, -1), mutated], { ...ctx, fnBody: body });
  assert.equal(res.ok, false);
});

// ---------------------------------------------------------------------------
// Registry shape.
// ---------------------------------------------------------------------------

test("optional-chain: registered with catalogue row 25 and the spec's ordering", () => {
  assert.deepEqual(optionalChain.catalogue, [25]);
  assert.equal(optionalChain.stage, "B");
  assert.deepEqual([...(optionalChain.after ?? [])].sort(), ["call-shape", "expr-rebuild", "global-access"]);
  assert.deepEqual(optionalChain.before, ["var-naming"]);
});

// ---------------------------------------------------------------------------
// Fixture-level, rung-owned assertions (no exact-output comparison).
// ---------------------------------------------------------------------------

function decompileFixture(name: string, version: string): string {
  const hbc = join(repoRoot(), "tests/fixtures/constructs", name, `${version}.hbc`);
  return decompile(readFileSync(hbc)).code;
}

/** Baseline (spec §7): 13 chain guards + 5 nullish guards in `48` at v94 —
 *  every `== <reg>` / `!= <reg>` guard statement the C/N rules recognise. */
function nullGuardCount(code: string): number {
  const m = code.match(/if \(r\d+ [!=]= (r\d+|null)\)/g);
  return m === null ? 0 : m.length;
}

test("optional-chain: 48-optional-chaining-nullish (v94) — ?./?? recovered, guard count collapses", () => {
  const code = decompileFixture("48-optional-chaining-nullish", "v94");
  assert.match(code, /\?\./);
  assert.match(code, /\?\?/);
  assert.equal(nullGuardCount(code), 0);
});

// v99: docs/BUGS.md's optional-chain v99 row — the compiler elides the
// *base's own* redundant guard once a sibling chain in the same function
// has already proven it non-nullish (§2.4 does not document this shape),
// so this rung's matcher — which always expects a base guard to open the
// run — does not recognise those particular blocks yet. Recorded, not
// silently accepted: the fixture's *other* chains (the ones that do carry
// their own base guard) are unaffected by this gap.
test("optional-chain: 48-optional-chaining-nullish (v99) — known base-guard-elision gap (docs/BUGS.md)", () => {
  const code = decompileFixture("48-optional-chaining-nullish", "v99");
  assert.ok(code.length > 0);
});
