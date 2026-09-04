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
import { parses } from "../../../src/passes/ast.ts";
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

/** `r7 = r6.profile?.contacts?.email;` — the run's own base guard is
 *  elided: the compiler had already proven `r6` non-nullish elsewhere
 *  (an object-literal base, or an earlier sibling chain over the same
 *  register — docs/lowering/optional-chaining.md §7), so the run opens
 *  directly with an unguarded link read instead of `rRes = undefined; if
 *  (r6 == N) break L;`. Reproduces `48-optional-chaining-nullish`'s own
 *  v99 `user?.profile?.contacts?.email` shape (`docs/BUGS.md`, row dated
 *  2026-09-02, `src/passes/optional-chain/match.ts`'s `matchBaseGuard`). */
function elidedBaseGuardBody(): readonly Stmt[] {
  return [
    asg(id("r2"), lit("null")),
    asg(id("r9"), mem(id("r6"), "profile")), // unguarded first link — base guard elided
    asg(id("r3"), { k: "bin", op: "==", left: id("r9"), right: id("r2") }),
    asg(id("r7"), lit("undefined")),
    iff(id("r3"), [brk("L1")]),
    asg(id("r9"), mem(id("r9"), "contacts")),
    asg(id("r3"), { k: "bin", op: "==", left: id("r9"), right: id("r2") }),
    asg(id("r7"), lit("undefined")),
    iff(id("r3"), [brk("L1")]),
    asg(id("r7"), mem(id("r9"), "email")),
    brk("L1"),
  ];
}

for (const [name, body] of [
  ["one-link", oneLinkBody()],
  ["three-link", threeLinkBody()],
  ["computed", computedBody()],
  ["call", callBody()],
  ["v99 spilled-compare", v99Body()],
  ["elided base guard (v99 base-guard-elision, BUGS 2026-09-02)", elidedBaseGuardBody()],
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

test("optional-chain: an elided base guard keys the base link on `.`, not `?.` (docs/BUGS.md 2026-09-02)", () => {
  const body = elidedBaseGuardBody();
  const m = match(body, { ...ctx, fnBody: body });
  assert.ok(m !== null);
  assert.equal(m!.data.kind, "chain");
  if (m!.data.kind !== "chain") return;
  // The spec's own note (§4): "the first link may be unguarded in source
  // (`a.b?.c`)" — an elided base guard is a plain access, never `user?.`.
  assert.deepEqual(
    m!.data.links.map((l) => l.guarded),
    [false, true, true],
  );
  const after = rewrite(m!);
  const commit = after[after.length - 1]! as Extract<Stmt, { k: "expr" }>;
  const value = (commit.expr as Extract<Expr, { k: "assign" }>).value;
  assert.equal(value.k, "optmember"); // outermost link (.email) — guarded
  const mid = (value as Extract<Expr, { k: "optmember" }>).obj;
  assert.equal(mid.k, "optmember"); // .contacts — guarded
  const base = (mid as Extract<Expr, { k: "optmember" }>).obj;
  assert.equal(base.k, "member"); // .profile — base guard elided, plain access
});

// ---------------------------------------------------------------------------
// Precondition 1, position-aware (docs/BUGS.md, isNullSentinel/nullWriteCount
// follow-up, 2026-09-05): the reaching-write proof, not the old whole-
// function "only write is literal null" rule.
// ---------------------------------------------------------------------------

/** v99 one-link shape whose sentinel test reads `r2`, split across three
 *  sibling labeled blocks in `fnBody` the way real functions actually lay
 *  chains out (48-optional-chaining-nullish's own shape): the null write
 *  lives in an earlier sibling, the chain's guard reads it in the middle
 *  sibling (the one `match` is given as `list`), and a *later* sibling may
 *  reuse the same register for something else entirely. */
function chainBodyReadingR2(): readonly Stmt[] {
  return [
    asg(id("r3"), { k: "bin", op: "==", left: id("r13"), right: id("r2") }),
    asg(id("r6"), lit("undefined")),
    iff(id("r3"), [brk("L1")]),
    asg(id("r6"), mem(id("r13"), "name")),
    brk("L1"),
  ];
}

test("optional-chain: the sentinel register may be reused for something else LATER in the function (docs/BUGS.md, isNullSentinel follow-up)", () => {
  const nullDef: Stmt[] = [asg(id("r2"), lit("null"))];
  const chainBody = chainBodyReadingR2();
  const laterReuse: Stmt[] = [asg(id("r2"), lit("false"))]; // a later, unrelated write to the SAME register
  const fnBody: readonly Stmt[] = [
    { k: "labeled", label: "L0", body: nullDef },
    { k: "labeled", label: "L1", body: chainBody },
    { k: "labeled", label: "L9", body: laterReuse },
  ];
  const m = match(chainBody, { ...ctx, fnBody });
  assert.ok(m !== null, "the later, unrelated reuse of r2 must not defeat a guard that reads r2 strictly before it");
  assert.equal(m!.data.kind, "chain");
  const after = rewrite(m!);
  const res = check(chainBody, after, { ...ctx, fnBody });
  assert.equal(res.ok, true, res.reason);
});

test("optional-chain: refuses when a write to the sentinel register sits BETWEEN the null write and the guard (docs/BUGS.md, isNullSentinel follow-up)", () => {
  const nullDef: Stmt[] = [asg(id("r2"), lit("null"))];
  const clobber: Stmt[] = [asg(id("r2"), lit("false"))]; // a write BETWEEN the null write and the read
  const chainBody = chainBodyReadingR2();
  const fnBody: readonly Stmt[] = [
    { k: "labeled", label: "L0", body: nullDef },
    { k: "labeled", label: "Lmid", body: clobber },
    { k: "labeled", label: "L1", body: chainBody },
  ];
  const m = match(chainBody, { ...ctx, fnBody });
  assert.equal(m, null, "a write to the sentinel register between the null write and the guard's read must refuse (not-null-guard)");
});

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

// `stage-b-per-site-parses` (docs/BUGS.md): a per-site `parses(after)` call
// used to refuse a site the instant its enclosing statement list also held
// an untouched bare `break`/`continue` — legal in the real function (an
// enclosing loop/switch this list-level check never sees), illegal only
// because `parses` wraps *this list alone* standalone. Prepending one such
// statement, untouched by the rewrite, must not change the verdict.
test("optional-chain: check does not refuse a site whose enclosing list also holds an untouched bare `break`", () => {
  const bareBreak: Stmt = { k: "break", label: null };
  const body = [bareBreak, ...oneLinkBody()];
  const m = match(body, { ...ctx, fnBody: body });
  assert.ok(m !== null);
  const after = rewrite(m!);
  // The bug this guards: printing `after` alone (as this per-site checker
  // used to) is not valid JS on its own — proof the fix is not vacuous.
  assert.equal(parses(after), false);
  const res = check(body, after, { ...ctx, fnBody: body });
  assert.equal(res.ok, true, res.reason);
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

// v99, second follow-up (docs/BUGS.md, `isNullSentinel`/`nullWriteCount`
// row): `isNullSentinelAt`'s reaching-write proof replaces the old whole-
// function "only write is literal null" rule, which this fixture's real
// v99 binary defeated for *every* chain (elided-base or not) by reusing the
// null-sentinel register (`r2`) later in the same function — confirmed 0
// chains recovered at v99 both before the base-guard-elision fix and after
// it, right up until this row's own fix. Measured (`tools/perf` not
// needed — plain substring counts on this fixture's own decompiled code):
// 0 `?.`/`??` occurrences and 0 chains before -> 9 `?.` + 3 `??`
// occurrences after, matching v94's shape 1:1 except one site.
function countMatches(code: string, re: RegExp): number {
  return (code.match(re) ?? []).length;
}
test("optional-chain: 48-optional-chaining-nullish (v99) — the null-sentinel-reuse gap is fixed, chains recover (docs/BUGS.md)", () => {
  const code = decompileFixture("48-optional-chaining-nullish", "v99");
  assert.match(code, /\?\./);
  assert.match(code, /\?\?/);
  // Real measured counts on this fixture post-fix: 9 `?.` occurrences
  // (L1/L2/L3 3-link chains, `.fetch?.()`/`.missingMethod?.()`, `?.property`)
  // and 3 `??` occurrences (the three nullish-coalescing sites) — assert
  // with headroom rather than pinning the exact numbers (CLAUDE.md: no
  // exact-output comparison against a shared fixture).
  assert.ok(countMatches(code, /\?\./g) >= 6, `expected >=6 ?. occurrences after the fix, got ${countMatches(code, /\?\./g)}`);
  assert.ok(countMatches(code, /\?\?/g) >= 3, `expected >=3 ?? occurrences after the fix, got ${countMatches(code, /\?\?/g)}`);
  assert.equal(nullGuardCount(code), 0); // no residual v94-shape inline `==`/`!=` guard
  // The v99 spilled-compare shape's residual guard (`if (rX) { break L; }`,
  // never matched by `nullGuardCount` above since it has no inline `==`/
  // `!=`) is now down to at most 1 — `user?.profile?.name` (L0), left
  // unrewritten for an unrelated, separately-tracked reason (a dead
  // `r1 = undefined` store interleaved between its own compare and its
  // guard, unrelated to `isNullSentinel` — not this row's fix to make).
  const bareGuardCount = countMatches(code, /if \(\w+\) \{\s*break \w+;\s*\}/g);
  assert.ok(bareGuardCount <= 1, `expected <=1 residual bare guard (L0's own, separately-tracked gap), got ${bareGuardCount}`);
});
