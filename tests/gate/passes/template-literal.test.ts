// docs/specs/passes/14-template-literal.md — unit tests on hand-built ASTs
// (§7: >= 1 positive per rule — odd `flat`, even `flat`, nested template,
// `dup:true`, `dup:false`; negatives for a `+` chain, a computed chunk, a
// concat receiver register with two writes, a template object read twice,
// two calls sharing one id; a real `check` refusal; PL-08 idempotence; the
// call-shape order-independence negative), F14 printer/framework
// properties, red->green on the two target fixtures at all five HBC
// versions and the .min/.obf variants (rung-owned properties only — no
// exact-output assertions on shared fixtures), and the §7 corpus metric.
//
// Metric scope (mirrors var-naming-metrics.test.ts): the gate measures v94 +
// v99 base variants; the full five-version × base/.min/.obf matrix and the
// RN template bundle run in the sweep tier and are reported in
// docs/STATUS.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { requireSweep } from "../../support/tiers.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { printProgram } from "../../../src/emit/print.ts";
import { applyAstPasses, effectSequence, identUses, parses, walk } from "../../../src/passes/ast.ts";
import { classifyNode as callShapeClassify } from "../../../src/passes/call-shape/match.ts";
import { check } from "../../../src/passes/template-literal/check.ts";
import { templateLiteral } from "../../../src/passes/template-literal/index.ts";
import { cook, decodeStringLiteral, deriveSites, escapeForTemplate, match } from "../../../src/passes/template-literal/match.ts";
import { rewrite } from "../../../src/passes/template-literal/rewrite.ts";
import type { Pass, PassContext } from "../../../src/passes/types.ts";
import { measureTemplateLiteral, measureTemplateLiteralBundle } from "../../../tools/passes-metrics.mjs";

// ---------------------------------------------------------------------------
// Hand-built-AST helpers.
// ---------------------------------------------------------------------------

const assignExpr = (target: Expr, value: Expr): Expr => ({ k: "assign", target, value });
const set = (name: string, value: Expr): Stmt => ({ k: "expr", expr: assignExpr(id(name), value) });
const exprStmt = (e: Expr): Stmt => ({ k: "expr", expr: e });
const call = (callee: Expr, args: readonly Expr[]): Expr => ({ k: "call", callee, args });
const member = (obj: Expr, prop: string): Expr => ({ k: "member", obj, prop: lit(prop), computed: false });
const arr = (elements: readonly Expr[]): Expr => ({ k: "array", elements });
const str = (s: string): Expr => lit(JSON.stringify(s));
const concat = (): Expr => member(id("__hbc_HermesInternal"), "concat");
const concatApply = (F: Expr, C0: Expr, args: readonly Expr[]): Expr => call(member(id("Reflect"), "apply"), [F, C0, arr(args)]);
const templateObject = (...args: readonly Expr[]): Expr => call(id("__hbc_b_getTemplateObject"), args);

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

function run(before: readonly Stmt[]): readonly Stmt[] {
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null, "expected a match");
  const after = rewrite(m);
  assert.deepEqual(check(before, after, ctx), { ok: true });
  // PL-08: structural fixed point — the rewrite's own output has no site.
  assert.equal(match(after, ctxFor(after)), null, "second run must rewrite nothing");
  return after;
}

// ---------------------------------------------------------------------------
// T1 positives.
// ---------------------------------------------------------------------------

test("T1: odd flat — `Hello, ${name}!`", () => {
  const before = [set("r5", concatApply(concat(), str("Hello, "), [id("r3"), str("!")]))];
  const after = run(before);
  assert.deepEqual(after, [set("r5", { k: "template", quasis: ["Hello, ", "!"], exprs: [id("r3")] })]);
  assert.equal(printProgram(after), "r5 = `Hello, ${r3}!`;\n");
});

test("T1: even flat — trailing empty chunk appended; substitutions reused by reference", () => {
  const a1 = id("a1");
  const a2 = id("a2");
  const before: readonly Stmt[] = [{ k: "return", arg: concatApply(concat(), str(""), [a2, str(":"), a1]) }];
  const after = run(before);
  const ret = after[0]!;
  assert.equal(ret.k, "return");
  const t = (ret as { arg: Expr }).arg;
  assert.equal(t.k, "template");
  const tpl = t as Expr & { readonly k: "template" };
  assert.deepEqual(tpl.quasis, ["", ":", ""]);
  assert.equal(tpl.exprs[0], a2);
  assert.equal(tpl.exprs[1], a1);
  assert.equal(printProgram(after), "return `${a2}:${a1}`;\n");
});

test("T1: spilled callee and chunk registers resolve from the nearest preceding definition in the list", () => {
  const before = [set("r5", concat()), set("r2", str(" = ")), { k: "return", arg: concatApply(id("r5"), str(""), [id("r9"), str(" + "), id("r8"), id("r2"), id("r16")]) } as Stmt];
  const after = run(before);
  assert.equal(printProgram(after), "r5 = __hbc_HermesInternal.concat;\nr2 = \" = \";\nreturn `${r9} + ${r8} = ${r16}`;\n");
});

test("T1: a register reused for two different string values resolves to the nearest one (Hermes scratch reuse)", () => {
  const before = [set("r2", str("first")), set("r1", concatApply(concat(), id("r2"), [id("x")])), set("r2", str("second")), set("r3", concatApply(concat(), id("r2"), [id("y")]))];
  const after = run(before);
  assert.equal(printProgram(after), 'r2 = "first";\nr1 = `first${x}`;\nr2 = "second";\nr3 = `second${y}`;\n');
});

test("T1: nested template — an inner concat inside an outer's substitution, both rewritten in one batch", () => {
  const inner = concatApply(concat(), str("inner-"), [lit("2")]);
  const before = [set("r5", concatApply(concat(), str("outer-"), [inner, str("-end")]))];
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null);
  assert.equal(m.data.sites.length, 2, "one batched match carries both sites");
  const after = rewrite(m);
  assert.deepEqual(check(before, after, ctx), { ok: true });
  assert.equal(printProgram(after), "r5 = `outer-${`inner-${2}`}-end`;\n");
  assert.equal(match(after, ctxFor(after)), null);
});

test("T1: multi-line chunks print as real newlines; backtick, backslash and ${ are escaped", () => {
  const before = [set("r5", concatApply(concat(), str("Line one\nLine two with "), [id("r4"), str(" items\nLine `three` \\ ${x} \t end")]))];
  const after = run(before);
  const printed = printProgram(after);
  assert.equal(printed, "r5 = `Line one\nLine two with ${r4} items\nLine \\`three\\` \\\\ \\${x} \\x09 end`;\n");
  assert.ok(parses(after));
});

// ---------------------------------------------------------------------------
// T2 positives.
// ---------------------------------------------------------------------------

test("T2: dup:false — raw and cooked halves, escapes printed raw, statement A deleted", () => {
  const before = [set("r4", str("d")), set("r6", templateObject(lit("0"), lit("false"), str("a\\n"), str("b\\tc"), id("r4"), str("a\n"), str("b\tc"), id("r4"))), set("r5", member(id("r0"), "inspect")), set("r3", lit("undefined")), set("r1", call(id("r5"), [id("r6"), lit("42"), lit("43")]))];
  const after = run(before);
  assert.equal(after.length, before.length - 1);
  assert.equal(printProgram(after), 'r4 = "d";\nr5 = r0.inspect;\nr3 = undefined;\nr1 = r5`a\\n${42}b\\tc${43}d`;\n');
});

test("T2: dup:true — strings serve as both raw and cooked; id/dup/strings resolve from registers", () => {
  const before = [set("r16", lit("1")), set("r14", str("<p>")), set("r13", str("</p>")), set("r15", lit("true")), set("r6", templateObject(id("r16"), id("r15"), id("r14"), id("r13"))), set("r4", member(id("r0"), "html")), set("r1", str("safe & sound")), set("r1", call(id("r4"), [id("r6"), id("r1")]))];
  const after = run(before);
  assert.equal(printProgram(after).split("\n").at(-2), "r1 = r4`<p>${r1}</p>`;");
});

test("T2: the template-object register may be reused later — B redefines it, or a later pure write ends its life", () => {
  // B writes rT itself (`r1 = r0(r1)`), and r1 is read again afterwards.
  const a = [set("r1", templateObject(lit("2"), lit("true"), str("no subs here"))), set("r0", member(id("r0"), "firstArgOnly")), set("r1", call(id("r0"), [id("r1")])), set("r0", call(id("r2"), [id("r1")]))];
  assert.equal(printProgram(run(a)).split("\n")[1], "r1 = r0`no subs here`;");
  // rT reused by a later pure write after B.
  const b = [set("r6", templateObject(lit("0"), lit("true"), str("x"))), set("r1", call(id("f"), [id("r6")])), set("r6", lit("5")), set("r2", id("r6"))];
  assert.equal(printProgram(run(b)), "r1 = f`x`;\nr6 = 5;\nr2 = r6;\n");
});

test("T2: a tagged template's effect sequence is the same (callee shape, argc) record the untagged call had", () => {
  const before = [set("r6", templateObject(lit("0"), lit("true"), str("x"), str("y"))), set("r1", call(member(id("o"), "tag"), [id("r6"), id("v")]))];
  const after = run(before);
  assert.deepEqual(effectSequence(after), effectSequence([before[1]!]));
});

// ---------------------------------------------------------------------------
// Negatives.
// ---------------------------------------------------------------------------

test("negative: a `+` chain is never a template — the rung matches no `bin` at any operand count", () => {
  const chain: Expr = { k: "bin", op: "+", left: { k: "bin", op: "+", left: str("check("), right: id("r1") }, right: str(")") };
  const before = [set("r0", chain), set("r2", { k: "bin", op: "+", left: str("Line one\nLine two "), right: id("r3") })];
  assert.equal(match(before, ctxFor(before)), null);
  assert.deepEqual(deriveSites(before, before).refusals, []);
});

test("negative: a computed chunk refuses non-literal-chunk", () => {
  const before = [set("r5", concatApply(concat(), call(id("f"), []), [id("x"), str("!")]))];
  assert.equal(match(before, ctxFor(before)), null);
  assert.deepEqual(deriveSites(before, before).refusals, [{ stmtIndex: 0, reason: "non-literal-chunk" }]);
});

test("negative: a concat receiver register with two writes and no dominating definition in the list refuses", () => {
  const body = [{ k: "if", test: id("c"), then: [set("r2", str("a"))], else: [set("r2", str("b"))] } as Stmt, set("r5", concatApply(concat(), id("r2"), [id("x")]))];
  assert.equal(match(body, ctxFor(body)), null);
  assert.deepEqual(deriveSites(body, body).refusals, [{ stmtIndex: 1, reason: "non-literal-chunk" }]);
});

test("negative: a concat callee register that cannot be proven refuses unresolved-concat", () => {
  const body = [{ k: "if", test: id("c"), then: [set("r5", concat())], else: [set("r5", id("g"))] } as Stmt, set("r1", concatApply(id("r5"), str("a"), [id("x")]))];
  assert.equal(match(body, ctxFor(body)), null);
  assert.deepEqual(deriveSites(body, body).refusals, [{ stmtIndex: 1, reason: "unresolved-concat" }]);
});

test("negative: a spread-materialised argument list refuses dynamic-args; a seq element refuses seq-argument", () => {
  const dyn = [set("r5", call(member(id("Reflect"), "apply"), [concat(), str("a"), id("r9")]))];
  assert.deepEqual(deriveSites(dyn, dyn).refusals, [{ stmtIndex: 0, reason: "dynamic-args" }]);
  const seq = [set("r5", concatApply(concat(), str("a"), [{ k: "seq", exprs: [id("x"), id("y")] }]))];
  assert.deepEqual(deriveSites(seq, seq).refusals, [{ stmtIndex: 0, reason: "seq-argument" }]);
});

test("negative: a template object read twice refuses shared-template-object", () => {
  const before = [set("r6", templateObject(lit("0"), lit("true"), str("x"))), set("r1", call(id("f"), [id("r6")])), set("r2", call(id("g"), [id("r6")]))];
  assert.equal(match(before, ctxFor(before)), null);
  assert.deepEqual(deriveSites(before, before).refusals, [{ stmtIndex: 0, reason: "shared-template-object" }]);
  // Read again from an enclosing list, outside the site's own list.
  const inner = [set("r6", templateObject(lit("0"), lit("true"), str("x"))), set("r1", call(id("f"), [id("r6")]))];
  const outer = [{ k: "if", test: id("c"), then: inner, else: [] } as Stmt, set("r2", id("r6"))];
  assert.equal(match(inner, ctxFor(outer)), null);
});

test("negative: two getTemplateObject calls sharing one id refuse duplicated-site-id", () => {
  const before = [set("r6", templateObject(lit("0"), lit("true"), str("x"))), set("r1", call(id("f"), [id("r6")])), set("r7", templateObject(lit("0"), lit("true"), str("y"))), set("r2", call(id("g"), [id("r7")]))];
  assert.equal(match(before, ctxFor(before)), null);
  assert.deepEqual(
    deriveSites(before, before).refusals.map((r) => r.reason),
    ["duplicated-site-id", "duplicated-site-id"],
  );
});

test("negative: raw-cooked-mismatch, arity-mismatch, raw-does-not-cook, interleaved-effect, nested-template-object", () => {
  const odd = [set("r6", templateObject(lit("0"), lit("false"), str("a"), str("b"), str("c"))), set("r1", call(id("f"), [id("r6")]))];
  assert.deepEqual(deriveSites(odd, odd).refusals, [{ stmtIndex: 0, reason: "raw-cooked-mismatch" }]);
  const arity = [set("r6", templateObject(lit("0"), lit("true"), str("a"), str("b"))), set("r1", call(id("f"), [id("r6"), id("x"), id("y")]))];
  assert.deepEqual(deriveSites(arity, arity).refusals, [{ stmtIndex: 0, reason: "arity-mismatch" }]);
  const cooks = [set("r6", templateObject(lit("0"), lit("false"), str("a\\n"), str("a\\n"))), set("r1", call(id("f"), [id("r6")]))];
  assert.deepEqual(deriveSites(cooks, cooks).refusals, [{ stmtIndex: 0, reason: "raw-does-not-cook" }]);
  const interleaved = [set("r6", templateObject(lit("0"), lit("true"), str("a"))), exprStmt(call(id("sideEffect"), [])), set("r1", call(id("f"), [id("r6")]))];
  assert.deepEqual(deriveSites(interleaved, interleaved).refusals, [{ stmtIndex: 0, reason: "interleaved-effect" }]);
  const nested = [set("r6", call(id("wrap"), [templateObject(lit("0"), lit("true"), str("a"))])), set("r1", call(id("f"), [id("r6")]))];
  assert.deepEqual(deriveSites(nested, nested).refusals, [{ stmtIndex: 0, reason: "nested-template-object" }]);
});

test("negative: a site with the template-object register also read from a nested closure by a non-register name is refused", () => {
  const before = [{ k: "init", kind: "let", name: "_e1_0", value: templateObject(lit("0"), lit("true"), str("a")) } as Stmt, { k: "func", name: "g", params: [], body: [set("r1", id("_e1_0"))] } as Stmt, set("r1", call(id("f"), [id("_e1_0")]))];
  assert.deepEqual(deriveSites(before, before).refusals, [{ stmtIndex: 0, reason: "shared-template-object" }]);
});

test("check refuses: a tampered rewrite (substitution reordered / statement dropped / no site)", () => {
  const before = [set("r5", concatApply(concat(), str("a"), [id("x"), str("b"), id("y")]))];
  const ctx = ctxFor(before);
  const swapped: readonly Stmt[] = [set("r5", { k: "template", quasis: ["a", "b", ""], exprs: [id("y"), id("x")] })];
  assert.equal(check(before, swapped, ctx).ok, false);
  assert.equal(check(before, [], ctx).ok, false);
  const plain = [set("r0", id("x"))];
  assert.equal(check(plain, plain, ctxFor(plain)).ok, false);
  const t2 = [set("r6", templateObject(lit("0"), lit("true"), str("x"))), set("r1", call(id("f"), [id("r6")]))];
  const kept: readonly Stmt[] = [t2[0]!, set("r1", { k: "tagged", tag: id("f"), quasi: { k: "template", quasis: ["x"], exprs: [] } })];
  assert.match(check(t2, kept, ctxFor(t2)).reason ?? "", /expected 1 statements/);
});

// ---------------------------------------------------------------------------
// Order independence with call-shape (§7): both rungs refuse the other's shape.
// ---------------------------------------------------------------------------

test("order independence: call-shape refuses a concat site; template-literal ignores a call-shape site", () => {
  const site = concatApply(concat(), str("Hello, "), [id("r3"), str("!")]);
  const body = [set("r5", site)];
  const v = callShapeClassify(site, body);
  assert.equal(v.ok, false);
  const r3a = [set("r1", lit("undefined")), set("r0", call(member(id("Reflect"), "apply"), [id("f"), id("r1"), arr([id("a")])]))];
  assert.equal(match(r3a, ctxFor(r3a)), null);
  assert.deepEqual(deriveSites(r3a, r3a).refusals, []);
});

// ---------------------------------------------------------------------------
// String helpers.
// ---------------------------------------------------------------------------

test("cook/escapeForTemplate: cook inverts escapeForTemplate on every string; invalid raw text cooks to undefined", () => {
  for (const s of ["", "plain", "a\nb", "a\\n", "`", "${x}", "$", "$$", "\t\r\0\x7f", "é ☃  ", "\\\\", "a\\`b"]) assert.equal(cook(escapeForTemplate(s)), s, JSON.stringify(s));
  assert.equal(cook("a\\n"), "a\n");
  assert.equal(cook("\\x41\\u0042\\u{43}\\d"), "ABCd");
  assert.equal(cook("a\\\nb"), "ab");
  assert.equal(cook("a\r\nb"), "a\nb");
  for (const bad of ["`", "${", "\\1", "\\08", "\\x4", "\\u12", "\\u{110000}", "a\\"]) assert.equal(cook(bad), undefined, JSON.stringify(bad));
});

test("decodeStringLiteral: the emitter's quoted form, and nothing else", () => {
  assert.equal(decodeStringLiteral('"a\\\\n"'), "a\\n");
  assert.equal(decodeStringLiteral('"a\\n\\t\\"\\x01\\u202f"'), 'a\n\t"\x01 ');
  assert.equal(decodeStringLiteral("42"), null);
  assert.equal(decodeStringLiteral('"\\q"'), null);
});

// ---------------------------------------------------------------------------
// F14 framework properties.
// ---------------------------------------------------------------------------

test("F14: printer precedence — template is primary, a binary tag is parenthesised, a member tag is not", () => {
  const tpl: Expr = { k: "template", quasis: ["a", "b"], exprs: [{ k: "seq", exprs: [id("x"), id("y")] }] };
  assert.equal(printProgram([exprStmt({ k: "bin", op: "+", left: tpl, right: id("z") })]), "`a${x, y}b` + z;\n");
  assert.equal(printProgram([exprStmt({ k: "tagged", tag: { k: "bin", op: "+", left: id("a"), right: id("b") }, quasi: { k: "template", quasis: ["x"], exprs: [] } })]), "(a + b)`x`;\n");
  assert.equal(printProgram([exprStmt(member({ k: "tagged", tag: member(id("o"), "t"), quasi: { k: "template", quasis: ["x"], exprs: [] } }, "length"))]), "o.t`x`.length;\n");
});

test("F14: walk/identUses see substitutions and the tag", () => {
  const stmts: readonly Stmt[] = [set("r1", { k: "tagged", tag: id("r9"), quasi: { k: "template", quasis: ["a", "b"], exprs: [id("r2")] } })];
  const seen: string[] = [];
  walk(stmts, { expr: (e) => { if (e.k === "ident") seen.push(e.name); } });
  assert.deepEqual(seen, ["r1", "r9", "r2"]);
  assert.equal(identUses(stmts, "r2").reads, 1);
  assert.equal(identUses(stmts, "r9").reads, 1);
});

// ---------------------------------------------------------------------------
// Driver integration + PL-08 through the real stage-B driver.
// ---------------------------------------------------------------------------

test("driver: one match per list, sites batched, second application is a no-op", () => {
  const body = [set("r5", concatApply(concat(), str("a"), [id("x")])), set("r6", templateObject(lit("0"), lit("true"), str("t"))), set("r1", call(id("f"), [id("r6")]))];
  const base = { analysis: null as unknown as PassContext["analysis"], functionIndex: 0, cfg: {} as PassContext["cfg"], hbcVersion: 94, layoutClass: "hbc94" as PassContext["layoutClass"], diagnostic: () => {} };
  const once = applyAstPasses(body, [templateLiteral as Pass<readonly Stmt[]>], base);
  assert.equal(once.applied.length, 1);
  assert.deepEqual(once.abandoned, []);
  assert.equal(printProgram(once.body), "r5 = `a${x}`;\nr1 = f`t`;\n");
  const twice = applyAstPasses(once.body, [templateLiteral as Pass<readonly Stmt[]>], base);
  assert.equal(twice.applied.length, 0);
  assert.equal(twice.body, once.body);
});

// ---------------------------------------------------------------------------
// Red->green on the target fixtures (rung-owned properties only).
// ---------------------------------------------------------------------------

const VERSIONS = [84, 94, 96, 98, 99] as const;
const VARIANTS = ["", ".min", ".obf"] as const;
// The inline concat form; the spilled form (`Reflect.apply(rK, …)` with
// `rK = __hbc_HermesInternal.concat` earlier) is not textually
// distinguishable from a call-shape-refused apply, so the fixture
// assertions below count template literals printed and the metric
// (`hasTemplateSites`, structural) covers the spilled form.
const INLINE_CONCAT_RE = /Reflect\.apply\(__hbc_HermesInternal\.concat, /g;
const TEMPLATE_OBJECT_CALL_RE = /= __hbc_b_getTemplateObject\(/g;
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

function fixture(name: string, version: number, variant: string): Uint8Array | null {
  const p = join(repoRoot(), "tests", "fixtures", "constructs", name, `v${version}${variant}.hbc`);
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
}

test("43-template-literals: concat calls become template literals at all five versions and every variant", () => {
  for (const v of VERSIONS) {
    for (const variant of VARIANTS) {
      const bytes = fixture("43-template-literals", v, variant);
      if (bytes === null) continue;
      const off = decompile(bytes, { moduleName: "x", resolveV98Ambiguity: true, passes: { skip: ["template-literal"] } }).code;
      const on = decompile(bytes, { moduleName: "x", resolveV98Ambiguity: true }).code;
      if (variant !== ".obf") assert.ok(count(off, INLINE_CONCAT_RE) >= 3, `v${v}${variant}: baseline should carry inline concat sites`); // .obf spills every callee
      assert.equal(count(on, INLINE_CONCAT_RE), 0, `v${v}${variant}: an inline concat site survived`);
      assert.equal(count(off, /`/g), 0, `v${v}${variant}: baseline prints no template`);
      // 5 source templates + 2 nested ones = 7 sites, 14 backticks. The
      // minifier constant-folds the nested pair (`outer-inner-2-end`), so
      // .min has 5 sites; the hardened .obf build lowers its templates to
      // other shapes altogether (no `concat` site is recognisable — the
      // metric's `hasTemplateSites` finds none), so there is nothing for
      // this rung to do there and the oracle covers behaviour.
      if (variant === "") assert.equal(count(on, /`/g), 14, `v${v}${variant}: expected all 7 sites rewritten`);
      else if (variant === ".min") assert.equal(count(on, /`/g), 10, `v${v}${variant}: expected all 5 sites rewritten`);
      if (variant !== ".obf") assert.ok(/`[^`]*\n[^`]*`/.test(on), `v${v}${variant}: the multi-line template should print across source lines`);
    }
  }
});

test("44-tagged-templates: getTemplateObject sites become tagged templates at all five versions and every variant", () => {
  for (const v of VERSIONS) {
    for (const variant of VARIANTS) {
      const bytes = fixture("44-tagged-templates", v, variant);
      if (bytes === null) continue;
      const off = decompile(bytes, { moduleName: "x", resolveV98Ambiguity: true, passes: { skip: ["template-literal"] } }).code;
      const on = decompile(bytes, { moduleName: "x", resolveV98Ambiguity: true }).code;
      assert.equal(count(off, TEMPLATE_OBJECT_CALL_RE), 3, `v${v}${variant}: baseline should carry three template-object sites`);
      // .obf: the hardened build's state machine defines the site ids
      // (`r56 = r32`, `r32` written twice in the frame) outside the site's
      // own list, calls the tag with an unproven receiver, and puts a TDZ
      // check between A and B — every one a correct refusal at some
      // version, so the variant only has to never regress (the oracle
      // covers behaviour).
      if (variant === ".obf") assert.ok(count(on, TEMPLATE_OBJECT_CALL_RE) <= 3, `v${v}${variant}: template-object sites multiplied`);
      else {
        assert.equal(count(on, TEMPLATE_OBJECT_CALL_RE), 0, `v${v}${variant}: a template-object site survived`);
        assert.ok(on.includes("`a\\n${"), `v${v}${variant}: raw text should print verbatim`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// §7 corpus metric: share of emitted functions with zero concat / zero
// getTemplateObject. Spec floor >= 90% (baseline 0% on 43/44).
// ---------------------------------------------------------------------------

const CLEAN_FUNCTION_PCT_FLOOR = 90;

test("template-literal corpus metric: clean-function share at v94+v99 base stays above the spec floor", () => {
  const result = measureTemplateLiteral([94, 99], [""]);
  assert.ok(result.functionCount >= 300, `expected the corpus scan to cover tests/fixtures/constructs/** at two versions, got ${result.functionCount} functions`);
  assert.ok(result.cleanFunctionPct > result.cleanFunctionPctBefore, `template-literal should strictly increase the clean-function share (${result.cleanFunctionPctBefore.toFixed(1)}% -> ${result.cleanFunctionPct.toFixed(1)}%)`);
  assert.ok(result.cleanFunctionPct >= CLEAN_FUNCTION_PCT_FLOOR, `clean-function share ${result.cleanFunctionPct.toFixed(1)}% is under the floor ${CLEAN_FUNCTION_PCT_FLOOR}%`);
  assert.equal(result.perFixture.filter((f) => f.fixture.startsWith("43-") || f.fixture.startsWith("44-")).every((f) => f.cleanFunctionsAfter === f.functions), true, "43/44 must be fully clean");
});

test("template-literal corpus metric: full five-version × base/.min/.obf matrix (sweep tier)", (t) => {
  if (!requireSweep(t)) return;
  const result = measureTemplateLiteral();
  assert.ok(result.cleanFunctionPct >= CLEAN_FUNCTION_PCT_FLOOR, `clean-function share ${result.cleanFunctionPct.toFixed(1)}% is under the floor ${CLEAN_FUNCTION_PCT_FLOOR}%`);
});

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const RN_TEMPLATE_FLOOR_PCT = 80;

test("template-literal corpus metric: RN template bundle clean-function share (sweep tier)", (t) => {
  if (!requireSweep(t)) return;
  if (!existsSync(RN_TEMPLATE)) {
    t.skip("rn-template-0.72/index.android.hbc not present");
    return;
  }
  const result = measureTemplateLiteralBundle(RN_TEMPLATE);
  assert.ok(result.functionCount > 500);
  assert.ok(result.cleanFunctionPct >= RN_TEMPLATE_FLOOR_PCT, `RN template bundle clean-function share ${result.cleanFunctionPct.toFixed(1)}% is under the floor ${RN_TEMPLATE_FLOOR_PCT}%`);
});

test("T2: a tag kept in Reflect.apply form with a proven-undefined receiver becomes a receiver-severed tagged template", () => {
  // 44 at v99: `r7 = getTemplateObject(...); r5 = Reflect.apply(r4.inspect, r2, [r7, 42, 43])`, `r2 = undefined`.
  const before = [set("r2", lit("undefined")), set("r10", str("d")), set("r7", templateObject(lit("0"), lit("false"), str("a\\n"), str("b\\tc"), id("r10"), str("a\n"), str("b\tc"), id("r10"))), set("r5", call(member(id("Reflect"), "apply"), [member(id("r4"), "inspect"), id("r2"), arr([id("r7"), lit("42"), lit("43")])]))];
  const after = run(before);
  assert.equal(printProgram(after).split("\n")[2], "r5 = (0, r4.inspect)`a\\n${42}b\\tc${43}d`;");
  // A plain identifier tag needs no severing; an unproven receiver refuses.
  const plain = [set("r7", templateObject(lit("0"), lit("true"), str("x"))), set("r5", call(member(id("Reflect"), "apply"), [id("f"), lit("undefined"), arr([id("r7")])]))];
  assert.equal(printProgram(run(plain)), "r5 = f`x`;\n");
  const unproven = [set("r7", templateObject(lit("0"), lit("true"), str("x"))), set("r5", call(member(id("Reflect"), "apply"), [member(id("o"), "m"), id("o"), arr([id("r7")])]))];
  assert.deepEqual(deriveSites(unproven, unproven).refusals, [{ stmtIndex: 0, reason: "shared-template-object" }]);
});
