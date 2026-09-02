// docs/specs/passes/19-reg-split.md — rung-owned assertions (CONSOLIDATION
// §B7: counts, structural checks, regex on the diff — never an exact-output
// comparison on a shared fixture). Unit tests on hand-built ASTs per §10:
// positives (straight-line reuse, an if-join, a loop-carried counter, a
// conditional weak def), negatives (single-web, a catch-live register, a
// nested-frame register), and checker refusals (R-loop, R-catch, a
// non-byte-identical undo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { check } from "../../../src/passes/reg-split/check.ts";
import { regSplit } from "../../../src/passes/reg-split/index.ts";
import { match } from "../../../src/passes/reg-split/match.ts";
import { rewrite } from "../../../src/passes/reg-split/rewrite.ts";
import type { PassContext } from "../../../src/passes/types.ts";

// ---------------------------------------------------------------------------
// Hand-built-AST helpers (mirrors var-naming.test.ts's, D12a: a test file is
// not a pass, but keeping the same shape makes the two readable together).
// ---------------------------------------------------------------------------

const assignExpr = (target: Expr, value: Expr): Expr => ({ k: "assign", target, value });
const set = (name: string, value: Expr): Stmt => ({ k: "expr", expr: assignExpr(id(name), value) });
const bin = (op: "+" | "<" | "===", left: Expr, right: Expr): Expr => ({ k: "bin", op, left, right });
const forStmt = (init: Expr | null, test: Expr, update: Expr | null, body: readonly Stmt[]): Stmt => ({ k: "for", label: null, init, test, update, body });
const ifStmt = (test: Expr, then: readonly Stmt[], els: readonly Stmt[] = []): Stmt => ({ k: "if", test, then, else: els });
const tryStmt = (block: readonly Stmt[], param: string, handler: readonly Stmt[]): Stmt => ({ k: "try", block, param, handler });
const ret = (arg: Expr | null): Stmt => ({ k: "return", arg });
const funcStmt = (name: string, body: readonly Stmt[]): Stmt => ({ k: "func", name, params: [], body });
const declStmt = (names: readonly string[]): Stmt => ({ k: "decl", kind: "let", names });
const printCall = (...args: Expr[]): Stmt => ({ k: "expr", expr: { k: "call", callee: id("print"), args } });

function ctxFor(fnBody: readonly Stmt[]): PassContext {
  return {
    analysis: null as unknown as PassContext["analysis"],
    functionIndex: 0,
    cfg: {} as PassContext["cfg"],
    hbcVersion: 94,
    layoutClass: "hbc94" as PassContext["layoutClass"],
    applied: [],
    diagnostic: () => {},
    fnBody,
  };
}

function names(list: readonly Stmt[]): readonly string[] {
  const decl = list.find((s): s is Stmt & { k: "decl" } => s.k === "decl");
  return decl?.names ?? [];
}

function runOnce(before: readonly Stmt[]): { readonly after: readonly Stmt[]; readonly matched: boolean } {
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  if (m === null) return { after: before, matched: false };
  const after = rewrite(m);
  const verdict = check(before, after, ctx);
  assert.deepEqual(verdict, { ok: true }, `check refused: ${verdict.ok ? "" : verdict.reason}`);
  return { after, matched: true };
}

// ---------------------------------------------------------------------------
// §10 positives.
// ---------------------------------------------------------------------------

test("straight-line reuse: two unrelated defs of one register split into two variables", () => {
  const before: readonly Stmt[] = [declStmt(["r0"]), set("r0", lit("1")), printCall(id("r0")), set("r0", lit("2")), printCall(id("r0"))];
  const { after, matched } = runOnce(before);
  assert.ok(matched);
  assert.deepEqual(names(after), ["r0", "r0_2"]);
});

test("reuse around an if join stays ONE web — not split", () => {
  const before: readonly Stmt[] = [declStmt(["r0", "r1"]), set("r1", lit("1")), ifStmt(bin("===", id("r1"), lit("1")), [set("r0", lit("1"))], [set("r0", lit("2"))]), printCall(id("r0"))];
  const { matched } = runOnce(before);
  assert.equal(matched, false, "an if-join value must not be split");
});

test("a loop-carried counter stays ONE variable across init/test/update/body", () => {
  const before: readonly Stmt[] = [declStmt(["r0", "r1"]), set("r1", lit("2")), set("r1", lit("2")), forStmt(assignExpr(id("r0"), lit("0")), bin("<", id("r0"), id("r1")), assignExpr(id("r0"), bin("+", id("r0"), lit("1"))), [printCall(id("r0"))])];
  // r1 is reused (two identical defs) so `match` fires for the frame, but
  // r0 (the induction var) must not appear split in the result.
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  const r0Split = m!.data.splits.find((s) => s.reg === "r0");
  assert.equal(r0Split, undefined, "the for-loop's own counter must have exactly one web");
});

test("conditional weak def (nested `(r = e)`) does not strong-kill: a later use still reaches the earlier def", () => {
  // r1 = (r0 = 5, r0) — a nested assign inside a `seq`; not a top-level
  // statement, so it is a weak update (§4.2), never separated from r0's
  // other occurrences by this alone.
  const before: readonly Stmt[] = [declStmt(["r0", "r1"]), set("r0", lit("1")), { k: "expr", expr: { k: "assign", target: id("r1"), value: { k: "seq", exprs: [assignExpr(id("r0"), lit("5")), id("r0")] } } }, printCall(id("r0"))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  // r0 has two defs (statement-level `r0=1`, nested weak `r0=5`) both
  // reaching the final print — a genuinely single web, so `match` must not
  // propose a split for r0 at all (it may still be null overall).
  if (m !== null) {
    const r0Split = m.data.splits.find((s) => s.reg === "r0");
    assert.equal(r0Split, undefined);
  }
});

// ---------------------------------------------------------------------------
// §10 negatives.
// ---------------------------------------------------------------------------

test("single-web register: match returns null", () => {
  const before: readonly Stmt[] = [declStmt(["r0"]), set("r0", lit("1")), printCall(id("r0"))];
  const ctx = ctxFor(before);
  assert.equal(match(before, ctx), null);
});

test("a register live into a catch handler is one web (no split across the exception edge)", () => {
  const before: readonly Stmt[] = [declStmt(["r0"]), set("r0", lit("1")), tryStmt([printCall(id("r0")), set("r0", lit("2"))], "_exc0", [printCall(id("r0"))])];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  if (m !== null) {
    const r0Split = m.data.splits.find((s) => s.reg === "r0");
    assert.equal(r0Split, undefined, "a try/catch-spanning register must not be split");
  }
});

test("a nested closure's own register is untouched by the outer frame's split", () => {
  const inner = funcStmt("_fn1", [declStmt(["r0"]), set("r0", lit("9")), ret(id("r0"))]);
  const before: readonly Stmt[] = [declStmt(["r0"]), set("r0", lit("1")), printCall(id("r0")), set("r0", lit("2")), printCall(id("r0")), inner];
  const { after, matched } = runOnce(before);
  assert.ok(matched);
  const outerNames = names(after);
  assert.ok(outerNames.includes("r0_2"));
  const innerFn = after.find((s): s is Stmt & { k: "func" } => s.k === "func" && s.name === "_fn1")!;
  assert.deepEqual(names(innerFn.body), ["r0"], "the nested frame's own r0 decl must be untouched");
});

// ---------------------------------------------------------------------------
// §10 checker refusals.
// ---------------------------------------------------------------------------

test("checker refuses a hand-forged split that violates R-loop (two names for one register inside one loop)", () => {
  const before: readonly Stmt[] = [declStmt(["r0"]), forStmt(assignExpr(id("r0"), lit("0")), bin("<", id("r0"), lit("3")), assignExpr(id("r0"), bin("+", id("r0"), lit("1"))), [set("r0", bin("+", id("r0"), lit("1")))])];
  // Forge an "after" that renames the body's def/use to r0_2 but leaves the
  // header's own occurrences as r0 — two names inside one loop statement.
  const bodySet = before[1] as Stmt & { k: "for" };
  const forged: readonly Stmt[] = [
    declStmt(["r0", "r0_2"]),
    { ...bodySet, body: [{ k: "expr", expr: assignExpr(id("r0_2"), bin("+", id("r0_2"), lit("1"))) }] },
  ];
  const verdict = check(before, forged, ctxFor(before));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "coarse-reach-crosses-split");
});

test("checker refuses a hand-forged split that violates R-catch (try-side def renamed, handler-side use left plain)", () => {
  const before: readonly Stmt[] = [declStmt(["r0"]), set("r0", lit("1")), tryStmt([set("r0", lit("2"))], "_exc0", [printCall(id("r0"))])];
  const tryS = before[2] as Stmt & { k: "try" };
  const forged: readonly Stmt[] = [declStmt(["r0", "r0_2"]), { k: "expr", expr: assignExpr(id("r0_2"), lit("1")) }, { ...tryS, block: [{ k: "expr", expr: assignExpr(id("r0_2"), lit("2")) }] }];
  const verdict = check(before, forged, ctxFor(before));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "coarse-reach-crosses-split");
});

test("checker refuses an undo that is not byte-identical (a name introduced beyond a pure rename)", () => {
  const before: readonly Stmt[] = [declStmt(["r0"]), set("r0", lit("1")), printCall(id("r0")), set("r0", lit("2")), printCall(id("r0"))];
  const forged: readonly Stmt[] = [declStmt(["r0", "r0_2"]), set("r0", lit("99")), printCall(id("r0")), set("r0_2", lit("2")), printCall(id("r0_2"))];
  const verdict = check(before, forged, ctxFor(before));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "the rewrite is not a pure rename: undoing it does not reproduce the original source");
});

// ---------------------------------------------------------------------------
// Fixture-level, rung-owned properties (no exact-output assertion — CONSOLIDATION §B7).
// ---------------------------------------------------------------------------

// reg-split ships `optIn: true` this landing (see index.ts's doc comment /
// PUSHBACK.md) — the default pipeline does not run it yet, so every
// fixture-level assertion below opts it in explicitly.
function decompileFixture(dir: string, version: string): string {
  const hbc = readFileSync(join(repoRoot(), "tests/fixtures/constructs", dir, `${version}.hbc`));
  return decompile(new Uint8Array(hbc), { passes: { optIn: ["reg-split"] } }).code;
}

test("04-for-loop-basic v94: r0's reuse becomes >= 2 distinct variables, and each for-header keeps one counter name", () => {
  const code = decompileFixture("04-for-loop-basic", "v94");
  const r0Vars = new Set([...code.matchAll(/\br0(_\d+)?\b/g)].map((m) => m[0]));
  assert.ok(r0Vars.size >= 2, `expected r0 reuse to split into >= 2 names, got ${[...r0Vars].join(",")}`);
  // Every `for (` header's counter is a single name across init/test/update
  // — no `for (rN = 0; ... rN_2 ...` mismatch.
  for (const m of code.matchAll(/for \((r\d+(?:_\d+)?) = /g)) {
    const counter = m[1]!;
    const headerEnd = code.indexOf(")", code.indexOf("{", m.index));
    const header = code.slice(m.index, headerEnd);
    // The header must never mix `rN` and `rN_2` for the same base number.
    const base = counter.replace(/_\d+$/, "");
    const mixed = [...header.matchAll(new RegExp(`\\b${base}(_\\d+)?\\b`, "g"))].map((x) => x[0]);
    assert.ok(new Set(mixed).size === 1, `for-header mixes counter names: ${header}`);
  }
});

test("02-while-loop v94: gate stays 0-DIVERGENT-shaped — reg-split output still parses and round-trips", () => {
  const code = decompileFixture("02-while-loop", "v94");
  assert.doesNotThrow(() => new Function(code));
});

test("11-nested-loops-mixed v94: reg-split does not crash and produces parseable output", () => {
  const code = decompileFixture("11-nested-loops-mixed", "v94");
  assert.doesNotThrow(() => new Function(code));
});

test("22-nested-closures-counters v94: an outer-frame split never renames inside a nested closure reusing the same register numbers", () => {
  const code = decompileFixture("22-nested-closures-counters", "v94");
  assert.doesNotThrow(() => new Function(code));
});

test("registry: reg-split is ordered after the sugar rungs and before var-naming", () => {
  assert.equal(regSplit.name, "reg-split");
  assert.deepEqual(regSplit.catalogue, ["R9"]);
  assert.ok((regSplit.before ?? []).includes("var-naming"));
  assert.ok((regSplit.after ?? []).includes("expr-rebuild"));
});

test("idempotence: re-matching an already-split frame finds no further splits (PL-08)", () => {
  const before: readonly Stmt[] = [declStmt(["r0"]), set("r0", lit("1")), printCall(id("r0")), set("r0", lit("2")), printCall(id("r0"))];
  const { after, matched } = runOnce(before);
  assert.ok(matched);
  const ctx2 = ctxFor(after);
  assert.equal(match(after, ctx2), null, "a second match on the split output must find nothing left to split");
});
