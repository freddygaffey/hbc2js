// docs/specs/passes/03-global-access.md — unit tests on hand-built ASTs (§7's
// checklist: one positive, negatives for a guard/read name mismatch, a
// shadowed name, a non-`globalThis` object, and a register with two
// `globalThis` stores; a real `check` refusal), plus red->green on the
// fixture corpus at all five HBC versions and the .min/.obf tiers.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { check } from "../../../src/passes/global-access/check.ts";
import { globalAccess } from "../../../src/passes/global-access/index.ts";
import { classifySite, match, recognizeGuard } from "../../../src/passes/global-access/match.ts";
import { rewrite } from "../../../src/passes/global-access/rewrite.ts";
import type { PassContext } from "../../../src/passes/types.ts";

// ---------------------------------------------------------------------------
// Hand-built-AST helpers.
// ---------------------------------------------------------------------------

const assignExpr = (target: Expr, value: Expr): Expr => ({ k: "assign", target, value });
const exprStmt = (e: Expr): Stmt => ({ k: "expr", expr: e });
const call = (callee: Expr, args: readonly Expr[]): Expr => ({ k: "call", callee, args });
const member = (obj: Expr, prop: string): Expr => ({ k: "member", obj, prop: lit(prop), computed: false });
const funcStmt = (name: string, body: readonly Stmt[]): Stmt => ({ k: "func", name, params: [], body });

/** A bare identifier the rung folds to — carries `global: true`, the marker
 *  `src/emit/scope-check.ts`'s EM-01 `checkBindings` accepts as a deliberate
 *  global read (see `Expr`'s `ident` doc). `rewrite`/`substitute` stamp every
 *  folded read with it, so a folded `after` must equal `gid(name)`, not
 *  `id(name)`. */
const gid = (name: string): Expr => ({ k: "ident", name, global: true });

/** `Reflect.apply(callee, thisArg, args)` — the pre-`call-shape` call shape
 *  every real fixture uses at this point in the pipeline (`call-shape` is
 *  not registered yet). A hand-built test that instead made a target read
 *  the direct *callee* of a `call` node would exercise a shape `call-shape`
 *  itself produces, never one `global-access` (which runs *before* it) can
 *  see, and `effectSequence`'s `calleeShape` is (correctly) sensitive to
 *  exactly that node's own identity — using the real pre-`call-shape` shape
 *  here avoids conflating a same-order-only argument with a callee. */
const reflectApply = (callee: Expr, thisArg: Expr, args: readonly Expr[]): Expr => call(member(id("Reflect"), "apply"), [callee, thisArg, { k: "array", elements: args }]);

/** A double-quoted string literal, ASCII-only (matches `src/emit/names.ts`'s
 *  `quote` for the plain identifier text every test here uses). */
const quoted = (s: string): Expr => lit(`"${s}"`);

/** §2's baseline guard shape for property `p` on object `g`. */
function guardFor(p: string, g: Expr): Stmt {
  return {
    k: "if",
    test: { k: "unary", op: "!", arg: { k: "bin", op: "in", left: quoted(p), right: g } },
    then: [{ k: "throw", arg: { k: "new", callee: id("ReferenceError"), args: [quoted(`Property '${p}' doesn't exist`)] } }],
    else: [],
  };
}

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

// ---------------------------------------------------------------------------
// §4 — one positive per shape `isProvenGlobal` recognises.
// ---------------------------------------------------------------------------

test("positive: a register proven global (single write, no nested capture) folds its guarded read to a bare identifier", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("globalThis"))), guardFor("Array", id("r1")), exprStmt(reflectApply(member(id("r1"), "Array"), id("undefined"), []))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.guardIndex, 1);
  assert.equal(m.data.useIndex, 2);
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(assignExpr(id("r1"), id("globalThis"))), exprStmt(reflectApply(gid("Array"), id("undefined"), []))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

test("positive: `globalThis` used bare (already inlined by expr-rebuild) needs no register proof at all", () => {
  const before: readonly Stmt[] = [guardFor("Array", id("globalThis")), exprStmt(reflectApply(member(id("globalThis"), "Array"), id("undefined"), []))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(reflectApply(gid("Array"), id("undefined"), []))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

test("positive: a register whose *first* write is globalThis, reused for scratch afterwards, still proves global for the guards before the reuse", () => {
  // The dominant real-corpus shape (§4's `isProvenGlobal` doc comment):
  // Hermes reuses the dead globalThis-holding register once its last guarded
  // read has passed, most commonly right before a `return`.
  const before: readonly Stmt[] = [
    exprStmt(assignExpr(id("r0"), id("globalThis"))),
    guardFor("Array", id("r0")),
    exprStmt(assignExpr(id("r5"), reflectApply(member(id("r0"), "Array"), id("undefined"), []))),
    exprStmt(assignExpr(id("r0"), lit('"done"'))), // r0 reused for something else entirely
    { k: "return", arg: id("r0") },
  ];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  const after = rewrite(m);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

// ---------------------------------------------------------------------------
// §7 — refuse reasons: negatives (match finds nothing at all).
// ---------------------------------------------------------------------------

test("no-read-after-guard: the read's property name differs from the guard's", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("globalThis"))), guardFor("Array", id("r1")), exprStmt(call(member(id("r1"), "Object"), []))];
  assert.equal(match(before, ctxFor(before)), null);
  const shape = recognizeGuard(before[1]!)!;
  const v = classifySite(before, before, 1, shape.name, shape.global);
  assert.deepEqual(v, { ok: false, reason: "no-read-after-guard" });
});

test("shadowed: the property name is already a register/env-slot/param-shaped name", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("globalThis"))), guardFor("r2", id("r1")), exprStmt(call(member(id("r1"), "r2"), []))];
  assert.equal(match(before, ctxFor(before)), null);
  const shape = recognizeGuard(before[1]!)!;
  const v = classifySite(before, before, 1, shape.name, shape.global);
  assert.deepEqual(v, { ok: false, reason: "shadowed" });
});

test("shadowed: the property name is declared as a local elsewhere in the function", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("globalThis"))), { k: "decl", kind: "let", names: ["Array"] }, guardFor("Array", id("r1")), exprStmt(call(member(id("r1"), "Array"), []))];
  assert.equal(match(before, ctxFor(before)), null);
  const shape = recognizeGuard(before[2]!)!;
  const v = classifySite(before, before, 2, shape.name, shape.global);
  assert.deepEqual(v, { ok: false, reason: "shadowed" });
});

test("unproven-global: the object's one write is not `globalThis`", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("somethingElse"))), guardFor("Array", id("r1")), exprStmt(call(member(id("r1"), "Array"), []))];
  assert.equal(match(before, ctxFor(before)), null);
  const shape = recognizeGuard(before[1]!)!;
  const v = classifySite(before, before, 1, shape.name, shape.global);
  assert.deepEqual(v, { ok: false, reason: "unproven-global" });
});

test("unproven-global: a register with two `globalThis` stores is ambiguous, refused even though every individual store is legitimate", () => {
  const before: readonly Stmt[] = [
    exprStmt(assignExpr(id("r1"), id("globalThis"))),
    guardFor("Array", id("r1")),
    exprStmt(call(member(id("r1"), "Array"), [])),
    exprStmt(assignExpr(id("r1"), id("globalThis"))), // a second, ambiguous globalThis store
    guardFor("Object", id("r1")),
    exprStmt(call(member(id("r1"), "Object"), [])),
  ];
  assert.equal(match(before, ctxFor(before)), null);
  const shape = recognizeGuard(before[1]!)!;
  const v = classifySite(before, before, 1, shape.name, shape.global);
  assert.deepEqual(v, { ok: false, reason: "unproven-global" });
});

test("unsafe-identifier: a reserved word is never introduced as a bare identifier", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("globalThis"))), guardFor("default", id("r1")), exprStmt(call(member(id("r1"), "default"), []))];
  assert.equal(match(before, ctxFor(before)), null);
  const shape = recognizeGuard(before[1]!)!;
  const v = classifySite(before, before, 1, shape.name, shape.global);
  assert.deepEqual(v, { ok: false, reason: "unsafe-identifier" });
});

test("positive: a real host global (`print`) now folds — the folded read is stamped `global: true`, which src/emit/scope-check.ts's EM-01 checkBindings accepts as a deliberate global read (the emitter marker, not the old KNOWN_GLOBALS cap)", () => {
  // `print` is a real host global, not an ECMAScript intrinsic — before the
  // emitter marker landed this hit `unbound-in-emitted-scope` and refused.
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("globalThis"))), guardFor("print", id("r1")), exprStmt(reflectApply(member(id("r1"), "print"), id("undefined"), []))];
  const ctx = ctxFor(before);
  const shape = recognizeGuard(before[1]!)!;
  assert.deepEqual(classifySite(before, before, 1, shape.name, shape.global), { ok: true, site: { guardIndex: 1, useIndex: 2, name: "print", global: id("r1") } });
  const m = match(before, ctx);
  assert.ok(m !== null);
  const after = rewrite(m);
  assert.deepEqual(after, [exprStmt(assignExpr(id("r1"), id("globalThis"))), exprStmt(reflectApply(gid("print"), id("undefined"), []))]);
  assert.deepEqual(check(before, after, ctx), { ok: true });
});

test("clobbered-between: a statement between the guard and the read reassigns the object", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("globalThis"))), guardFor("Array", id("r1")), exprStmt(assignExpr(id("r1"), id("somethingElse"))), exprStmt(call(member(id("r1"), "Array"), []))];
  assert.equal(match(before, ctxFor(before)), null);
  const shape = recognizeGuard(before[1]!)!;
  const v = classifySite(before, before, 1, shape.name, shape.global);
  assert.deepEqual(v, { ok: false, reason: "clobbered-between" });
});

test("read-twice: the read's statement mentions the property twice", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("globalThis"))), guardFor("Array", id("r1")), exprStmt(call(id("f"), [member(id("r1"), "Array"), member(id("r1"), "Array")]))];
  assert.equal(match(before, ctxFor(before)), null);
  const shape = recognizeGuard(before[1]!)!;
  const v = classifySite(before, before, 1, shape.name, shape.global);
  assert.deepEqual(v, { ok: false, reason: "read-twice" });
});

test("guard-in-other-list: a read that migrated into a nested `if` body is refused, not chased", () => {
  const before: readonly Stmt[] = [
    exprStmt(assignExpr(id("r1"), id("globalThis"))),
    guardFor("Array", id("r1")),
    { k: "if", test: id("cond"), then: [exprStmt(call(member(id("r1"), "Array"), []))], else: [] },
  ];
  assert.equal(match(before, ctxFor(before)), null);
  const shape = recognizeGuard(before[1]!)!;
  const v = classifySite(before, before, 1, shape.name, shape.global);
  assert.deepEqual(v, { ok: false, reason: "guard-in-other-list" });
});

// ---------------------------------------------------------------------------
// §7 — a *real* `check` refusing a real site (not a stubbed check).
// ---------------------------------------------------------------------------

test("check refuses a hand-crafted `after` that deletes the guard but leaves the read untouched", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("globalThis"))), guardFor("Array", id("r1")), exprStmt(call(member(id("r1"), "Array"), []))];
  const wronglyRewrittenAfter: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("globalThis"))), exprStmt(call(member(id("r1"), "Array"), []))];
  const ctx = ctxFor(before);
  const verdict = check(before, wronglyRewrittenAfter, ctx);
  assert.equal(verdict.ok, false);
});

test("check refuses an `after` that introduces the identifier at the wrong statement", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("globalThis"))), guardFor("Array", id("r1")), exprStmt(call(member(id("r1"), "Array"), [])), exprStmt(call(id("noop"), []))];
  // Correctly deletes the guard, but "rewrites" the *following*, unrelated
  // statement instead of the one the guard actually licenses.
  const wronglyRewrittenAfter: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("globalThis"))), exprStmt(call(member(id("r1"), "Array"), [])), exprStmt(call(id("Array"), []))];
  const ctx = ctxFor(before);
  const verdict = check(before, wronglyRewrittenAfter, ctx);
  assert.equal(verdict.ok, false);
});

// ---------------------------------------------------------------------------
// PL-08 idempotence: a second `match` on the rewrite's own output finds nothing.
// ---------------------------------------------------------------------------

test("PL-08: global-access reaches a fixed point on its own output", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("globalThis"))), guardFor("Array", id("r1")), exprStmt(call(member(id("r1"), "Array"), []))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  const after = rewrite(m);
  assert.equal(match(after, ctxFor(after)), null);
});

test("a nested func's own frame is never reached by the outer list's match", () => {
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("globalThis"))), guardFor("Array", id("r1")), funcStmt("g", [exprStmt(call(member(id("r1"), "Array"), []))])];
  assert.equal(match(before, ctxFor(before)), null);
});

// ---------------------------------------------------------------------------
// §7 corpus fixtures — red -> green.
// ---------------------------------------------------------------------------

const VERSIONS = [84, 94, 96, 98, 99];
const VARIANTS = ["", ".min", ".obf"];

function loadFixture(name: string, version: number, variant: string): Uint8Array {
  return new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, `v${version}${variant}.hbc`)));
}

function inGuardCount(code: string): number {
  return (code.match(/!\("[^"]+" in /g) ?? []).length;
}

// Since the EM-01 emitter marker landed (`ident.global`; see
// `src/emit/scope-check.ts` and `match.ts`'s "Emitter interface" note), a
// *real host global* folds exactly like an intrinsic: the `targets` fixtures
// (`19-var-hoisting`, `01-if-else-chain`, `02-while-loop`) all guard on
// `"print"` — not an ECMAScript intrinsic — and their provable `print` guards
// now fold to bare `print` reads that `checkBindings` accepts. The loop still
// asserts the PL-05 safety property (never *increases* the guard count, never
// crashes) universally; a guard survives only where the object is not a
// proven global in that frame (a reused register, a migrated read, …), which
// is a correct refusal, so a strict reduction can't be asserted for every
// (fixture, version, variant). The strong red->green fold — bare `print` that
// still parses — is asserted in the `19`/`02` block below.
for (const target of globalAccess.targets) {
  for (const version of VERSIONS) {
    for (const variant of VARIANTS) {
      test(`safe: ${target} v${version}${variant} never crashes and never adds a guard`, () => {
        const bytes = loadFixture(target, version, variant);
        const withoutRung = decompile(bytes, { moduleName: target, resolveV98Ambiguity: true, passes: { skip: ["global-access"] } }).code;
        const withRung = decompile(bytes, { moduleName: target, resolveV98Ambiguity: true, passes: {} }).code;
        assert.ok(inGuardCount(withRung) <= inGuardCount(withoutRung), `expected no more "in" guards with global-access on ${target} v${version}${variant}`);
      });
    }
  }
}

// EM-01 marker regression: a `print`-guarded fixture folds its guarded reads
// to bare `print` and the result still parses. Before the marker, every one
// of these guards hit `unbound-in-emitted-scope` and none folded (or, if the
// pass had been allowed to fold, `decompile()` threw `E_UNBOUND_IDENT` from
// `checkBindings`). `decompile()` runs `checkBindings` internally, so a
// surviving crash would fail here; the bare-`print` assertion + a manual
// `node --check` (via `vm.Script`, matching the gate's own `syntaxOk`) close
// the "folds AND still decompiles/parses" requirement. The trace oracle is
// run over these fixtures with passes ON by the full-gate equivalence tier.
// `19-var-hoisting` guards on `print` and folds at least one guard at every
// version (unlike `02-while-loop`, whose globalThis-holding register is reused
// in a way that keeps `isProvenGlobal` from firing at v96/98/99 — a correct
// refusal, so it is not a reliable strict-reduction witness). The bare-`print`
// regex deliberately excludes a `'print'` inside the guard's own throw message.
for (const version of VERSIONS) {
  test(`EM-01 marker: 19-var-hoisting v${version} folds a real host global (print) to a bare read that still parses`, () => {
    const bytes = loadFixture("19-var-hoisting", version, "");
    const withoutRung = decompile(bytes, { moduleName: "19-var-hoisting", resolveV98Ambiguity: true, passes: { skip: ["global-access"] } }).code;
    const withRung = decompile(bytes, { moduleName: "19-var-hoisting", resolveV98Ambiguity: true, passes: {} }).code;
    assert.ok(inGuardCount(withRung) < inGuardCount(withoutRung), `expected fewer "in" guards (a real print guard folded) at v${version}`);
    assert.match(withRung, /[^.\w'"]print\s*[(;]/, `expected a bare (non-member) print read/call at v${version}`);
    // Must still be syntactically valid JS — checkBindings accepted the bare
    // print (its `ident.global` marker), so this compiles rather than throwing
    // E_UNBOUND_IDENT out of `decompile()` above.
    assert.doesNotThrow(() => new vm.Script(withRung), `folded output should parse at v${version}`);
  });
}

// A genuine, positive red->green demonstration through the *real* pipeline
// (decompile(), not a hand-built AST): `47-typeof-instanceof-in` guards
// `Object`/`Array`/`Symbol` *and* `print`. Every one is now a bindable global
// (intrinsics via scope-check's `KNOWN_GLOBALS`; `print` via the `ident.global`
// marker), so all of them fold — the whole `" in "` guard count goes to zero.
for (const version of VERSIONS) {
  test(`red->green: 47-typeof-instanceof-in v${version} — Object/Array/Symbol AND print guards all fold`, () => {
    const bytes = loadFixture("47-typeof-instanceof-in", version, "");
    const withoutRung = decompile(bytes, { moduleName: "x", resolveV98Ambiguity: true, passes: { skip: ["global-access"] } }).code;
    const withRung = decompile(bytes, { moduleName: "x", resolveV98Ambiguity: true, passes: {} }).code;
    assert.ok(inGuardCount(withRung) < inGuardCount(withoutRung), `expected fewer "in" guards with global-access on at v${version}`);
    assert.equal(inGuardCount(withRung), 0, `every global-access guard should fold at v${version}`);
    assert.doesNotMatch(withRung, /"Object" in|"Array" in|"Symbol" in|"print" in/, `Object/Array/Symbol/print guards should all be gone at v${version}`);
  });
}

test("v94 shape: 47-typeof-instanceof-in — a builtin read folds to a bare call/instanceof/property access", () => {
  const code = decompile(loadFixture("47-typeof-instanceof-in", 94, ""), { moduleName: "x" }).code;
  assert.match(code, /r2\.prototype = Object\.create\(r0\.Base\.prototype\);/);
  assert.match(code, /r17 = r2 instanceof Array;/);
  // `Symbol` folds to a bare identifier — the point of this assertion. Accept
  // either the pre-`call-shape` `Reflect.apply(Symbol, …)` wrapper or the
  // direct `Symbol()` a landed `call-shape` produces; both prove the fold, and
  // whether the call is unwrapped is orthogonal to global-access.
  assert.match(code, /r0 = (Reflect\.apply\(Symbol, r11, \[\]\)|Symbol\(\));/);
});
