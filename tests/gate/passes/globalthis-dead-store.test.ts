// ACCEPTANCE: docs/LOWERING-CATALOGUE.md R11 (`globalthis-dead-store`,
// docs/specs/passes/03-global-access.md section 5), regression for
// docs/BUGS.md 2026-09-01 "`r0 = globalThis` dead store survives the
// global-access rewrite" (M5 ladder / global-access owner).
//
// Unit tests on hand-built statement lists (the analysis of
// `src/passes/globalthis-dead-store/analysis.ts` and the checker's
// independent re-derivation), plus a red->green fixture test on
// `19-var-hoisting` (rung-owned property: a strictly lower count of
// surviving `rN = globalThis;` residues, never a whole-output comparison —
// CLAUDE.md testing rules).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { analyze, applyAnalysis } from "../../../src/passes/globalthis-dead-store/analysis.ts";
import { check } from "../../../src/passes/globalthis-dead-store/check.ts";
import { globalthisDeadStore } from "../../../src/passes/globalthis-dead-store/index.ts";
import { match } from "../../../src/passes/globalthis-dead-store/match.ts";
import { rewrite } from "../../../src/passes/globalthis-dead-store/rewrite.ts";
import type { PassContext } from "../../../src/passes/types.ts";
import { repoRoot } from "../../support/paths.ts";

const id = (name: string): Expr => ({ k: "ident", name });
const call = (callee: Expr, args: readonly Expr[]): Expr => ({ k: "call", callee, args });
const exprStmt = (e: Expr): Stmt => ({ k: "expr", expr: e });
const assignStmt = (target: Expr, value: Expr): Stmt => exprStmt({ k: "assign", target, value });
const decl = (names: readonly string[]): Stmt => ({ k: "decl", kind: "let", names });

function ctx(fnBody: readonly Stmt[]): PassContext {
  return {
    analysis: {} as PassContext["analysis"],
    functionIndex: 0,
    cfg: {} as PassContext["cfg"],
    hbcVersion: 94,
    layoutClass: "C",
    applied: [],
    diagnostic: () => {},
    fnBody,
  };
}

function loadFixture(name: string, version: number, variant: string): Buffer {
  return readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, `v${version}${variant}.hbc`));
}

// ---------------------------------------------------------------------------
// analysis.ts — hand-built ASTs.
// ---------------------------------------------------------------------------

test("analyze: a globalThis store with zero remaining reads of its register is dead", () => {
  const body: readonly Stmt[] = [decl(["r0"]), assignStmt(id("r0"), id("globalThis")), exprStmt(call(id("print"), []))];
  const a = analyze(body);
  assert.equal(a.deadStores.size, 1);
  assert.deepEqual(applyAnalysis(body, a), [decl(["r0"]), exprStmt(call(id("print"), []))]);
});

test("analyze: a register that is still read is not touched", () => {
  const body: readonly Stmt[] = [assignStmt(id("r0"), id("globalThis")), exprStmt(call(id("r0"), []))];
  const a = analyze(body);
  assert.equal(a.deadStores.size, 0);
  assert.equal(applyAnalysis(body, a), body);
});

test("analyze: a value other than the bare identifier `globalThis` is never a candidate", () => {
  const body: readonly Stmt[] = [assignStmt(id("r0"), call(id("f"), [])), exprStmt(call(id("print"), []))];
  assert.equal(analyze(body).deadStores.size, 0);
});

test("analyze: a non-register target (an already-named local) is never a candidate — var-naming's own refusal is this rung's other half, not overlap", () => {
  const body: readonly Stmt[] = [assignStmt(id("g"), id("globalThis")), exprStmt(call(id("print"), []))];
  assert.equal(analyze(body).deadStores.size, 0);
});

test("analyze: two independent dead globalThis stores in the same function both go in one pass", () => {
  const body: readonly Stmt[] = [assignStmt(id("r0"), id("globalThis")), assignStmt(id("r1"), id("globalThis")), exprStmt(call(id("print"), []))];
  const a = analyze(body);
  assert.equal(a.deadStores.size, 2);
  assert.deepEqual(applyAnalysis(body, a), [exprStmt(call(id("print"), []))]);
});

test("analyze: a dead globalThis store does not require the register's OTHER, unrelated write to disappear too — that write's own deadness is a different rung's business", () => {
  // r0 = globalThis (dead, no read of r0 ever); r0 = f() (also never read,
  // but not a globalThis store, so this rung must not touch it).
  const body: readonly Stmt[] = [assignStmt(id("r0"), id("globalThis")), assignStmt(id("r0"), call(id("f"), [])), exprStmt(call(id("print"), []))];
  const a = analyze(body);
  assert.equal(a.deadStores.size, 1);
  assert.deepEqual(applyAnalysis(body, a), [assignStmt(id("r0"), call(id("f"), [])), exprStmt(call(id("print"), []))]);
});

test("analyze: a nested func's own same-numbered register never hides a live outer read (register names never cross a func boundary)", () => {
  const body: readonly Stmt[] = [assignStmt(id("r0"), id("globalThis")), { k: "func", name: "g", params: [], body: [exprStmt(call(id("r0"), []))] }];
  // The outer r0 has zero reads in the outer frame — the nested `g`'s own r0
  // is a distinct binding — so the outer store is dead.
  assert.equal(analyze(body).deadStores.size, 1);
});

// ---------------------------------------------------------------------------
// match / rewrite / check.
// ---------------------------------------------------------------------------

test("match: only fires on the whole function body, not an arbitrary nested list", () => {
  const body: readonly Stmt[] = [assignStmt(id("r0"), id("globalThis")), exprStmt(call(id("print"), []))];
  const c = ctx(body);
  assert.ok(match(body, c) !== null);
  assert.equal(match([exprStmt(call(id("print"), []))], c), null, "not ctx.fnBody: refused");
});

test("match: no dead store at all is refused, not a vacuous match", () => {
  const body: readonly Stmt[] = [exprStmt(call(id("print"), []))];
  assert.equal(match(body, ctx(body)), null);
});

test("rewrite+check: round-trips exactly what analyze declared, and ok:true", () => {
  const body: readonly Stmt[] = [assignStmt(id("r0"), id("globalThis")), exprStmt(call(id("print"), []))];
  const c = ctx(body);
  const m = match(body, c)!;
  const after = rewrite(m, c);
  assert.deepEqual(after, [exprStmt(call(id("print"), []))]);
  assert.deepEqual(check(body, after, c), { ok: true });
});

test("check: refuses an `after` that is not exactly the declared deletion", () => {
  const body: readonly Stmt[] = [assignStmt(id("r0"), id("globalThis")), exprStmt(call(id("print"), []))];
  const c = ctx(body);
  const wrongAfter: readonly Stmt[] = [exprStmt(call(id("warn"), []))]; // deleted the store AND changed the call
  const verdict = check(body, wrongAfter, c);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /not exactly the declared deletions/);
});

test("check: refuses a rewrite applied to a `before` with no dead store to re-derive from", () => {
  const body: readonly Stmt[] = [exprStmt(call(id("print"), []))];
  const verdict = check(body, body, ctx(body));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /no matching site/);
});

test("the registered Pass object is match/rewrite/check as tested above, ordered after expr-rebuild/global-access and before the renaming rungs", () => {
  assert.equal(globalthisDeadStore.name, "globalthis-dead-store");
  assert.deepEqual(globalthisDeadStore.after, ["expr-rebuild", "global-access"]);
  assert.deepEqual(globalthisDeadStore.before, ["fn-naming", "reg-split", "var-naming"]);
  assert.equal(globalthisDeadStore.match, match);
  assert.equal(globalthisDeadStore.rewrite, rewrite);
  assert.equal(globalthisDeadStore.check, check);
});

// ---------------------------------------------------------------------------
// Fixture-level red->green: 19-var-hoisting's `demo` guards `print` and its
// module-scope function guards on `hasOwnProperty`/`DeclareGlobalVar` (spec
// 03 section 3's untouchable idiom) — a real bundle shape with one dead
// residue (the folded `print` guard's store) sitting next to one genuinely
// live `globalThis` store (feeding `.demo`/`.hoistedFn` — must survive).
// ---------------------------------------------------------------------------

const VERSIONS = [84, 94, 96, 98, 99];

for (const version of VERSIONS) {
  test(`red->green: 19-var-hoisting v${version} drops the dead print-guard's globalThis store but keeps the live DeclareGlobalVar one`, () => {
    const bytes = loadFixture("19-var-hoisting", version, "");
    const withoutRung = decompile(bytes, { moduleName: "x", resolveV98Ambiguity: true, passes: { skip: ["globalthis-dead-store"] } }).code;
    const withRung = decompile(bytes, { moduleName: "x", resolveV98Ambiguity: true, passes: {} }).code;
    const countStores = (code: string): number => (code.match(/\br\d+\s*=\s*globalThis;/g) ?? []).length;
    assert.ok(countStores(withRung) < countStores(withoutRung), `expected fewer surviving globalThis stores at v${version}`);
    // The DeclareGlobalVar-fed store (`.demo`/`.hoistedFn` reads follow it)
    // must never be deleted — it has real reads.
    assert.equal(countStores(withRung), 1, `exactly the live DeclareGlobalVar store should remain at v${version}`);
    assert.match(withRung, /\br(\d+)\s*=\s*globalThis;[\s\S]*?\br\1\.(?:demo|hoistedFn)/, `the surviving store must be the one \`.demo\`/\`.hoistedFn\` reads at v${version}`);
  });
}
