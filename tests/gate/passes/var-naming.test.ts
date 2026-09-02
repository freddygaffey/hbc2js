// docs/specs/passes/07-var-naming.md — unit tests on hand-built ASTs (§8's
// checklist: one positive per heuristic #1/#3/#4/#5/#6; negatives for a
// reused multi-role register, a globalThis alias, a register with no
// heuristic, and a nested-frame register that must not be renamed from the
// outer frame; a real `check` refusal), the batched-match contract, PL-08,
// plus rung-owned properties on the target fixtures at all five HBC
// versions and the .min/.obf tiers. No exact-output assertion on any shared
// fixture (those belong to no rung).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import type { ModuleView } from "../../../src/passes/tree.ts";
import { check } from "../../../src/passes/var-naming/check.ts";
import { varNaming } from "../../../src/passes/var-naming/index.ts";
import { classifySite, match } from "../../../src/passes/var-naming/match.ts";
import { renameRegisterInFrame, rewrite } from "../../../src/passes/var-naming/rewrite.ts";
import type { PassContext } from "../../../src/passes/types.ts";

// ---------------------------------------------------------------------------
// Hand-built-AST helpers.
// ---------------------------------------------------------------------------

const assignExpr = (target: Expr, value: Expr): Expr => ({ k: "assign", target, value });
const set = (name: string, value: Expr): Stmt => ({ k: "expr", expr: assignExpr(id(name), value) });
const exprStmt = (e: Expr): Stmt => ({ k: "expr", expr: e });
const member = (obj: Expr, prop: string): Expr => ({ k: "member", obj, prop: lit(prop), computed: false });
const call = (callee: Expr, args: readonly Expr[] = []): Expr => ({ k: "call", callee, args });
const newE = (callee: Expr, args: readonly Expr[] = []): Expr => ({ k: "new", callee, args });
const bin = (op: "+" | "*" | "<" | ">" | "===", left: Expr, right: Expr): Expr => ({ k: "bin", op, left, right });
const seq = (...exprs: Expr[]): Expr => ({ k: "seq", exprs });
const forStmt = (init: Expr | null, test: Expr, update: Expr | null, body: readonly Stmt[]): Stmt => ({ k: "for", label: null, init, test, update, body });
const ifStmt = (test: Expr, then: readonly Stmt[], els: readonly Stmt[] = []): Stmt => ({ k: "if", test, then, else: els });
const ret = (arg: Expr | null): Stmt => ({ k: "return", arg });
const funcStmt = (name: string, body: readonly Stmt[], params: readonly string[] = []): Stmt => ({ k: "func", name, params: params.map((n) => ({ name: n })), body });
const declStmt = (names: readonly string[]): Stmt => ({ k: "decl", kind: "let", names });
const printCall = (...args: Expr[]): Stmt => exprStmt(call(id("print"), args));

function fakeModule(): ModuleView {
  return {
    functionCount: 1,
    functionName: (): string => "",
    isGlobalFunction: (index: number): boolean => index === 0,
    envSlotAccesses: (): readonly { readonly functionIndex: number; readonly offset: number }[] => [],
    depsVerdict: (): null => null,
  };
}

/** `module: null` builds a context with no module view at all (the key is
 *  absent, as under `exactOptionalPropertyTypes` it must be). */
function ctxFor(fnBody: readonly Stmt[], module: ModuleView | null = fakeModule()): PassContext {
  return {
    analysis: null as unknown as PassContext["analysis"],
    functionIndex: 0,
    cfg: {} as PassContext["cfg"],
    hbcVersion: 94,
    layoutClass: "hbc94" as PassContext["layoutClass"],
    applied: [],
    diagnostic: () => {},
    fnBody,
    ...(module === null ? {} : { module }),
  };
}

/** match → rewrite → check on `before` as the driver would, returning the
 *  renamed list (and asserting `check` accepted it). */
function runOnce(before: readonly Stmt[]): { readonly renames: readonly { readonly from: string; readonly to: string }[]; readonly after: readonly Stmt[] } {
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null, "expected a match");
  const after = rewrite(m);
  const verdict = check(before, after, ctx);
  assert.deepEqual(verdict, { ok: true });
  return { renames: m.data.renames, after };
}

function names(list: readonly Stmt[]): readonly string[] {
  const decl = list.find((s): s is Stmt & { k: "decl" } => s.k === "decl");
  return decl?.names ?? [];
}

// ---------------------------------------------------------------------------
// §4.2 positives, one per heuristic.
// ---------------------------------------------------------------------------

test("#1 loop induction var: the assign target of a for's init and update, read in its test, becomes `i`; the literal bound it is compared against is named by the §9 Q4 ordering-comparison heuristic (`limit`), not #7's plain no-heuristic refusal", () => {
  const before: readonly Stmt[] = [declStmt(["r0", "r1"]), set("r1", lit("10")), forStmt(assignExpr(id("r0"), lit("0")), bin("<", id("r0"), id("r1")), assignExpr(id("r0"), bin("+", id("r0"), lit("1"))), [printCall(id("r0"))])];
  const { renames, after } = runOnce(before);
  assert.deepEqual(renames, [
    { from: "r1", to: "limit" },
    { from: "r0", to: "i" },
  ]);
  assert.deepEqual(names(after), ["i", "limit"]);
});

test("#1 nested loops draw the pool in first-def order: the outer head's two counters take `i`/`j`, the inner loop's `k`; a `seq` init/update is a valid head", () => {
  const inner = forStmt(assignExpr(id("r1"), lit("0")), bin("<", id("r1"), lit("3")), assignExpr(id("r1"), bin("+", id("r1"), lit("1"))), [printCall(id("r0"), id("r1"))]);
  const outer = forStmt(seq(assignExpr(id("r0"), lit("0")), assignExpr(id("r2"), lit("5"))), bin("<", id("r0"), id("r2")), seq(assignExpr(id("r0"), bin("+", id("r0"), lit("1"))), assignExpr(id("r2"), bin("+", id("r2"), lit("-1")))), [inner]);
  const before: readonly Stmt[] = [declStmt(["r0", "r1", "r2"]), outer];
  const { renames } = runOnce(before);
  assert.deepEqual(renames, [
    { from: "r0", to: "i" },
    { from: "r2", to: "j" },
    { from: "r1", to: "k" },
  ]);
});

test("#3 array: a `new Array(…)` def, an array literal, and a bare `.push` receiver all become `arr` (then `arr2`, `arr3`)", () => {
  const before: readonly Stmt[] = [
    declStmt(["r0", "r1", "r2"]),
    set("r0", newE(id("Array"), [lit("0")])),
    set("r1", { k: "array", elements: [] }),
    set("r2", id("a1")),
    exprStmt(call(member(id("r0"), "push"), [lit("1")])),
    exprStmt(call(member(id("r2"), "push"), [lit("2")])),
    ret(call(member(id("r1"), "join"), [lit('","')])),
  ];
  const { renames } = runOnce(before);
  assert.deepEqual(renames, [
    { from: "r0", to: "arr" },
    { from: "r1", to: "arr2" },
    { from: "r2", to: "arr3" },
  ]);
});

test("#4 call result: base from the callee — a free ident is suffixed (it is taken), a member callee gives its property, `new Error` gives `err`, `new Foo` gives `foo`", () => {
  const before: readonly Stmt[] = [
    declStmt(["r0", "r1", "r2", "r3"]),
    set("r0", call(id("load"), [lit("1")])),
    set("r1", call(member(id("cfg"), "parse"), [])),
    set("r2", newE(id("Error"), [lit('"x"')])),
    set("r3", newE(id("Foo"), [])),
    printCall(id("r0"), id("r1"), id("r2"), id("r3")),
  ];
  const { renames } = runOnce(before);
  assert.deepEqual(renames, [
    { from: "r0", to: "load2" },
    { from: "r1", to: "parse" },
    { from: "r2", to: "err" },
    { from: "r3", to: "foo" },
  ]);
});

test("#5 string accumulator: every def is a `+` chain reading the register itself (or a string-literal seed) → `s`", () => {
  const before: readonly Stmt[] = [declStmt(["r0"]), set("r0", lit('""')), set("r0", bin("+", id("r0"), lit('"a"'))), set("r0", bin("+", id("r0"), lit('"b"'))), ret(id("r0"))];
  const { renames } = runOnce(before);
  assert.deepEqual(renames, [{ from: "r0", to: "s" }]);
});

test("#6 boolean guard: a comparison def read as an `if` test → `ok`; the same def never read as a test is no-heuristic", () => {
  const guarded: readonly Stmt[] = [declStmt(["r0"]), set("r0", bin(">", id("a1"), lit("2"))), ifStmt(id("r0"), [printCall()])];
  assert.deepEqual(runOnce(guarded).renames, [{ from: "r0", to: "ok" }]);
  const unguarded: readonly Stmt[] = [declStmt(["r0"]), set("r0", bin(">", id("a1"), lit("2"))), ret(id("r0"))];
  assert.deepEqual(classifySite(unguarded, "r0"), { ok: false, reason: "no-heuristic" });
  assert.equal(match(unguarded, ctxFor(unguarded)), null);
});

// ---------------------------------------------------------------------------
// §9 Q4 compound upgrade (docs/specs/passes/19-reg-split.md) — one positive
// and one refusal per new heuristic, same convention as #1–#6 above.
// ---------------------------------------------------------------------------

test("§9 Q4 container-subscript: a register only ever subscripted (`r0[r1]`) becomes `list`; a register never subscripted keeps rN", () => {
  const before: readonly Stmt[] = [declStmt(["r0", "r1"]), set("r0", id("a1")), ret(member({ k: "member", obj: id("r0"), prop: id("r1"), computed: true }, "toString"))];
  assert.deepEqual(classifySite(before, "r0"), { ok: true, to: "list" });
  const bare: readonly Stmt[] = [declStmt(["r0"]), set("r0", id("a1")), ret(id("r0"))];
  assert.deepEqual(classifySite(bare, "r0"), { ok: false, reason: "no-heuristic" });
});

test("§9 Q4 object/closure literal: a single-def object literal becomes `obj`, a function expression becomes `fn`", () => {
  const before: readonly Stmt[] = [declStmt(["r0", "r1"]), set("r0", { k: "object", props: [] }), set("r1", { k: "func", name: null, params: [], body: [] } as unknown as Expr), ret(seq(id("r0"), id("r1")))];
  assert.deepEqual(classifySite(before, "r0"), { ok: true, to: "obj" });
  assert.deepEqual(classifySite(before, "r1"), { ok: true, to: "fn" });
});

test("§9 Q4 property alias: a non-computed member read (`a1.items`) takes the property's name; a computed read with a non-literal key has no heuristic", () => {
  const dotAccess: readonly Stmt[] = [declStmt(["r0"]), set("r0", member(id("a1"), "items")), ret(id("r0"))];
  assert.deepEqual(classifySite(dotAccess, "r0"), { ok: true, to: "items" });
  const dynamicAccess: readonly Stmt[] = [declStmt(["r0"]), set("r0", { k: "member", obj: id("a1"), prop: id("a2"), computed: true }), ret(id("r0"))];
  assert.deepEqual(classifySite(dynamicAccess, "r0"), { ok: false, reason: "no-heuristic" });
});

test("§9 Q4 alias-of-named-thing: a bare alias of a real (non-register, non-param) ident takes that name (suffixed here — `cache` is itself free in the body, §4.3's ordinary collision path); aliasing a bare param `aN` is refused (§4.2's params carve-out) rather than forced", () => {
  const namedAlias: readonly Stmt[] = [declStmt(["r0"]), set("r0", id("cache")), ret(id("r0"))];
  assert.deepEqual(classifySite(namedAlias, "r0"), { ok: true, to: "cache2" });
  const paramAlias: readonly Stmt[] = [declStmt(["r0"]), set("r0", id("a1")), ret(id("r0"))];
  assert.deepEqual(classifySite(paramAlias, "r0"), { ok: false, reason: "no-heuristic" });
});

test("§9 Q4 boolean-literal flag: a bare `true`/`false` def read as a test becomes `flag`; the same literal never read as a test is no-heuristic", () => {
  const guarded: readonly Stmt[] = [declStmt(["r0"]), set("r0", lit("true")), ifStmt(id("r0"), [printCall()])];
  assert.deepEqual(classifySite(guarded, "r0"), { ok: true, to: "flag" });
  const unguarded: readonly Stmt[] = [declStmt(["r0"]), set("r0", lit("false")), ret(id("r0"))];
  assert.deepEqual(classifySite(unguarded, "r0"), { ok: false, reason: "no-heuristic" });
});

test("§9 Q4 ordering-comparison bound: a bare numeric literal compared with `<` becomes `limit`; the same literal used only in a `+` (never compared) is no-heuristic", () => {
  const bound: readonly Stmt[] = [declStmt(["r0", "r1"]), set("r1", lit("10")), ifStmt(bin("<", id("r0"), id("r1")), [printCall()])];
  assert.deepEqual(classifySite(bound, "r1"), { ok: true, to: "limit" });
  const unused: readonly Stmt[] = [declStmt(["r0"]), set("r0", lit("10")), ret(bin("+", id("r0"), lit("1")))];
  assert.deepEqual(classifySite(unused, "r0"), { ok: false, reason: "no-heuristic" });
});

test("§9 Q4 numeric accumulator: a `0`-seeded `+`-chain becomes `sum` (distinct from the string accumulator's `s`)", () => {
  const before: readonly Stmt[] = [declStmt(["r0"]), set("r0", lit("0")), set("r0", bin("+", id("r0"), id("a1"))), ret(id("r0"))];
  assert.deepEqual(runOnce(before).renames, [{ from: "r0", to: "sum" }]);
});

test("§9 Q4 widened array evidence: a `.map`/`.filter`/`.forEach` receiver becomes `arr` just like `.push`/`.join` did before", () => {
  const before: readonly Stmt[] = [declStmt(["r0"]), set("r0", id("a1")), exprStmt(call(member(id("r0"), "forEach"), [id("a2")])), ret(call(member(id("r0"), "map"), [id("a2")]))];
  assert.deepEqual(classifySite(before, "r0"), { ok: true, to: "arr" });
});

// ---------------------------------------------------------------------------
// §4.1/§4.2 negatives.
// ---------------------------------------------------------------------------

test("reuse-conflict: a register whose defs mix roles keeps rN — an array then a constant; a loop counter later aliased to `print`", () => {
  const mixed: readonly Stmt[] = [declStmt(["r0"]), set("r0", newE(id("Array"), [lit("0")])), exprStmt(call(member(id("r0"), "push"), [lit("1")])), set("r0", lit("5")), ret(id("r0"))];
  assert.deepEqual(classifySite(mixed, "r0"), { ok: false, reason: "reuse-conflict" });
  const counter: readonly Stmt[] = [
    declStmt(["r0"]),
    forStmt(assignExpr(id("r0"), lit("0")), bin("<", id("r0"), lit("3")), assignExpr(id("r0"), bin("+", id("r0"), lit("1"))), [printCall(id("r0"))]),
    set("r0", id("print")),
    exprStmt(call(id("r0"), [lit('"done"')])),
  ];
  assert.deepEqual(classifySite(counter, "r0"), { ok: false, reason: "reuse-conflict" });
  assert.equal(match(counter, ctxFor(counter)), null);
});

test("globalthis-alias: `rN = globalThis` is refused, never given a readable name", () => {
  const before: readonly Stmt[] = [declStmt(["r0"]), set("r0", id("globalThis")), ret(member(id("r0"), "print"))];
  assert.deepEqual(classifySite(before, "r0"), { ok: false, reason: "globalthis-alias" });
  assert.equal(match(before, ctxFor(before)), null);
});

test("no-heuristic: a single-def literal, and a register with no def at all, keep rN", () => {
  const before: readonly Stmt[] = [declStmt(["r0", "r1"]), set("r0", lit("5")), ret(bin("+", id("r0"), id("r1")))];
  assert.deepEqual(classifySite(before, "r0"), { ok: false, reason: "no-heuristic" });
  assert.deepEqual(classifySite(before, "r1"), { ok: false, reason: "no-heuristic" });
  assert.equal(match(before, ctxFor(before)), null);
});

test("§5 frame-locality: a nested func's own r0 is a different frame — untouched by the outer rename, and never itself a site", () => {
  const nested = funcStmt("_fn1", [declStmt(["r0"]), set("r0", lit("5")), ret(id("r0"))]);
  const before: readonly Stmt[] = [declStmt(["r0"]), set("r0", newE(id("Array"), [lit("0")])), nested, exprStmt(call(member(id("r0"), "push"), [call(id("_fn1"))]))];
  const { renames, after } = runOnce(before);
  assert.deepEqual(renames, [{ from: "r0", to: "arr" }]);
  assert.equal(after[2], nested, "the nested func statement must be the very same object — the writer never descends into it");
  assert.equal(match(nested.k === "func" ? nested.body : [], ctxFor(before)), null, "a nested body is not this site (list !== ctx.fnBody)");
});

test("§4.3 collision: a name already free or declared in the frame (including inside a nested func) is skipped over; the induction pool skips taken letters", () => {
  const before: readonly Stmt[] = [
    declStmt(["r0", "r1"]),
    funcStmt("helper", [ret(id("i"))], ["arr"]), // `arr` is a nested param, `i` a nested free name
    set("r1", newE(id("Array"), [])),
    forStmt(assignExpr(id("r0"), lit("0")), bin("<", id("r0"), lit("3")), assignExpr(id("r0"), bin("+", id("r0"), lit("1"))), [exprStmt(call(member(id("r1"), "push"), [id("r0")]))]),
  ];
  const { renames } = runOnce(before);
  assert.deepEqual(renames, [
    { from: "r1", to: "arr2" },
    { from: "r0", to: "j" },
  ]);
});

test("match is null without a module view, and null for any list that is not the function body root", () => {
  const before: readonly Stmt[] = [declStmt(["r0"]), set("r0", newE(id("Array"), [])), exprStmt(call(member(id("r0"), "push"), [lit("1")]))];
  assert.equal(match(before, ctxFor(before, null)), null);
  assert.equal(match(before, ctxFor([...before])), null);
});

// ---------------------------------------------------------------------------
// §7 checker refusals.
// ---------------------------------------------------------------------------

test("check refuses a hand-crafted `after` that renamed the decl entry but left a reference untouched", () => {
  const before: readonly Stmt[] = [declStmt(["r0"]), set("r0", newE(id("Array"), [])), exprStmt(call(member(id("r0"), "push"), [lit("1")]))];
  const after: readonly Stmt[] = [declStmt(["arr"]), set("arr", newE(id("Array"), [])), exprStmt(call(member(id("r0"), "push"), [lit("1")]))];
  const verdict = check(before, after, ctxFor(before));
  assert.equal(verdict.ok, false);
});

test("check refuses an `after` whose rename reached into a nested func's frame (the §5 bug)", () => {
  const nestedBefore = funcStmt("_fn1", [declStmt(["r0"]), set("r0", lit("5")), ret(id("r0"))]);
  const nestedAfter = funcStmt("_fn1", [declStmt(["arr"]), set("arr", lit("5")), ret(id("arr"))]);
  const before: readonly Stmt[] = [declStmt(["r0"]), set("r0", newE(id("Array"), [])), nestedBefore, exprStmt(call(member(id("r0"), "push"), [call(id("_fn1"))]))];
  const wrong: readonly Stmt[] = [declStmt(["arr"]), set("arr", newE(id("Array"), [])), nestedAfter, exprStmt(call(member(id("arr"), "push"), [call(id("_fn1"))]))];
  assert.equal(check(before, wrong, ctxFor(before)).ok, false);
  const right = renameRegisterInFrame(before, "r0", "arr");
  assert.deepEqual(check(before, right, ctxFor(before)), { ok: true });
});

test("check refuses a target that is a reserved word, an emitter name class (incl. aN), or already declared", () => {
  const before: readonly Stmt[] = [declStmt(["r0"]), set("r0", newE(id("Array"), [])), exprStmt(call(member(id("r0"), "push"), [id("x")]))];
  for (const bad of ["class", "a1", "_fn3", "x"]) {
    assert.equal(check(before, renameRegisterInFrame(before, "r0", bad), ctxFor(before)).ok, false, `expected check to refuse "${bad}"`);
  }
});

// ---------------------------------------------------------------------------
// Batched match, PL-08.
// ---------------------------------------------------------------------------

test("one match carries every qualifying rename in the frame (spec 05 §4 convention): one rewrite, one check", () => {
  const before: readonly Stmt[] = [
    declStmt(["r0", "r1", "r2"]),
    set("r1", newE(id("Array"), [])),
    forStmt(assignExpr(id("r0"), lit("0")), bin("<", id("r0"), lit("3")), assignExpr(id("r0"), bin("+", id("r0"), lit("1"))), [exprStmt(call(member(id("r1"), "push"), [id("r0")]))]),
    set("r2", call(member(id("r1"), "join"), [lit('""')])),
    ret(id("r2")),
  ];
  const { renames, after } = runOnce(before);
  assert.equal(renames.length, 3);
  assert.deepEqual(names(after), ["i", "arr", "join"]);
});

test("PL-08: var-naming reaches a fixed point on its own output", () => {
  const before: readonly Stmt[] = [
    declStmt(["r0", "r1", "r2", "r3"]),
    set("r1", newE(id("Array"), [])),
    set("r3", id("globalThis")),
    forStmt(assignExpr(id("r0"), lit("0")), bin("<", id("r0"), lit("3")), assignExpr(id("r0"), bin("+", id("r0"), lit("1"))), [exprStmt(call(member(id("r1"), "push"), [id("r0")]))]),
    set("r2", lit("7")),
    ret(bin("+", id("r2"), member(id("r3"), "x"))),
  ];
  let current = before;
  for (let round = 0; round < 5; round++) {
    const m = match(current, ctxFor(current));
    if (m === null) break;
    current = rewrite(m);
  }
  assert.equal(match(current, ctxFor(current)), null);
  assert.deepEqual(names(current), ["i", "arr", "r2", "r3"]);
});

// ---------------------------------------------------------------------------
// §8 fixtures — rung-owned properties only (never exact output).
// ---------------------------------------------------------------------------

const VERSIONS = [84, 94, 96, 98, 99];
const VARIANTS = ["", ".min", ".obf"];

function loadFixture(name: string, version: number, variant: string): Uint8Array {
  return new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, `v${version}${variant}.hbc`)));
}

/** Distinct register variables declared by the emitter's `let r…` decls. */
function declaredRegisters(code: string): number {
  let n = 0;
  for (const m of code.matchAll(/^\s*let ((?:\w+, )*\w+);$/gm)) n += m[1]!.split(", ").filter((x) => /^r\d+$/.test(x)).length;
  return n;
}

for (const target of varNaming.targets) {
  for (const version of VERSIONS) {
    for (const variant of VARIANTS) {
      test(`safe: ${target} v${version}${variant} never crashes, never adds a register variable, and prints valid JS`, () => {
        const bytes = loadFixture(target, version, variant);
        const without = decompile(bytes, { moduleName: target, resolveV98Ambiguity: true, passes: { skip: ["var-naming"] } }).code;
        const withRung = decompile(bytes, { moduleName: target, resolveV98Ambiguity: true, passes: {} }).code;
        assert.ok(declaredRegisters(withRung) <= declaredRegisters(without), `expected no more rN variables with var-naming on for ${target} v${version}${variant}`);
        assert.doesNotThrow(() => new Function(withRung), "the renamed program must still parse");
      });
    }
  }
}

test("red->green: 04-for-loop-basic v94 — the single-def `new Array` register becomes `arr` and is the `.push`/`.join` receiver; the heavily reused r0 stays an rN (reg-split default-on may still split it into rN_j webs, but var-naming's §6 reuse gate must never give any of them a semantic name)", () => {
  const code = decompile(loadFixture("04-for-loop-basic", 94, ""), { moduleName: "x" }).code;
  assert.match(code, /\barr = new Array\(0\);/);
  assert.match(code, /\barr\.push\(/);
  assert.match(code, /\barr\.join\(/);
  // `r\d+(_\d+)?` also matches reg-split's `rN_j` web names (D23, reg-split
  // is default-on; docs/specs/passes/19-reg-split.md §Q3) — a register split
  // into several disjoint webs is still each web's own multi-role scratch,
  // which var-naming's reuse gate must decline to rename.
  assert.match(code, /\br0(_\d+)? = /, "the multi-role scratch register must keep its rN(_j) (§6 reuse gate)");
});

test("red->green: 04-for-loop-basic v94 — F10 still prunes dead registers from a decl var-naming has renamed into", () => {
  const code = decompile(loadFixture("04-for-loop-basic", 94, ""), { moduleName: "x" }).code;
  const decl = /^\s*let ((?:\w+, )*\w+);$/m.exec(code);
  assert.ok(decl !== null);
  for (const name of decl[1]!.split(", ")) {
    const occurrences = (code.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
    assert.ok(occurrences >= 2, `declared ${name} has no use in the body — the decl was not pruned`);
  }
});

test("red->green: 22-nested-closures-counters v94 — the closure's `.push` receiver is named in its own frame only (no rename leaks across frames)", () => {
  const code = decompile(loadFixture("22-nested-closures-counters", 94, ""), { moduleName: "x" }).code;
  assert.match(code, /\barr\.push\(/);
  assert.doesNotThrow(() => new Function(code));
});

// `template-literal` (registered after this test was written) turns every
// `Reflect.apply(__hbc_HermesInternal.concat, …)` in this fixture into a
// template literal, so with it on the fixture no longer has a single-def
// *call-result* register for var-naming's heuristic to name. It is skipped
// on both sides here so the assertion keeps testing exactly what its title
// says — the same way call-shape's v99 shape test skips var-naming.
test("red->green: 43-template-literals v94 — at least one single-def call-result register is named", () => {
  const bytes = loadFixture("43-template-literals", 94, "");
  const without = decompile(bytes, { moduleName: "x", passes: { skip: ["var-naming", "template-literal"] } }).code;
  const withRung = decompile(bytes, { moduleName: "x", passes: { skip: ["template-literal"] } }).code;
  assert.ok(declaredRegisters(withRung) < declaredRegisters(without), "expected fewer rN variables with var-naming on");
});
