// CONSOLIDATION 4 (continued) — mutation-tests the STAGE-A (CFG/tree-IR)
// checkers `checker-mutation.test.ts` left unprobed (docs/reports/2026-09-02
// -checker-mutation.md: "stage-A checkers need CFG-block-bearing fixtures"),
// plus the empirical mutation-testing of template-literal and jsx-recover
// that report read as robust by inspection but never actually ran a mutation
// against. Same shape as `checker-mutation.test.ts`: a real (before, after)
// from the pass's own `match`+`rewrite` (or, for for-header/loop-cond, a real
// CFG through `structure()` — `tests/gate/passes/synth.ts`, never a hand-
// rolled CFG), then a hand-mutated `after` that a plausible future bug in
// `rewrite.ts` could produce, asserting the real `check` rejects it. A case
// that turns out to be ACCEPTED is a real hole: `test.todo`, pinned with the
// actual (wrong) `{ ok: true }` verdict in a comment, and filed in
// docs/BUGS.md (cluster: passes) — never silently dropped or weakened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { structure } from "../../../src/structure/index.ts";
import type { Stmt } from "../../../src/structure/ir.ts";
import { applyPasses } from "../../../src/passes/driver.ts";
import { forHeader } from "../../../src/passes/for-header/index.ts";
import type { ForMatch } from "../../../src/passes/for-header/match.ts";
import { loopCond } from "../../../src/passes/loop-cond/index.ts";
import { ifChain } from "../../../src/passes/if-chain/index.ts";
import { switchRaise } from "../../../src/passes/switch-raise/index.ts";
import type { SwitchArm } from "../../../src/structure/ir.ts";
import type { SwitchTable } from "../../../src/disasm/switchtable.ts";
import { labelClean } from "../../../src/passes/label-clean/index.ts";
import type { Pass, PassContext } from "../../../src/passes/types.ts";
import { countingLoop, synthCfg } from "./synth.ts";
import type { Expr } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import type { Stmt as AstStmt } from "../../../src/emit/ast.ts";
import { match as tlMatch } from "../../../src/passes/template-literal/match.ts";
import { rewrite as tlRewrite } from "../../../src/passes/template-literal/rewrite.ts";
import { check as tlCheck } from "../../../src/passes/template-literal/check.ts";
import { match as jsxMatch } from "../../../src/passes/jsx-recover/match.ts";
import { rewrite as jsxRewrite } from "../../../src/passes/jsx-recover/rewrite.ts";
import { check as jsxCheck } from "../../../src/passes/jsx-recover/check.ts";

type Base = Omit<PassContext, "applied" | "structured" | "parentOf">;
const base = (cfg: ReturnType<typeof synthCfg>): Base => ({ analysis: null as unknown as PassContext["analysis"], functionIndex: 0, cfg, hbcVersion: 94, layoutClass: "hbc94" as PassContext["layoutClass"], diagnostic: () => {} });
const bareCtx = (): PassContext => ({ analysis: null as unknown as PassContext["analysis"], functionIndex: 0, cfg: null as unknown as PassContext["cfg"], hbcVersion: 94, layoutClass: "hbc94" as PassContext["layoutClass"], applied: [], diagnostic: () => {} });
const findLoop = (root: Stmt): Stmt & { k: "loop" } => {
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.k === "loop") return n;
    if (n.k === "seq") stack.push(...n.body);
    else if (n.k === "if") stack.push(n.then, n.else);
    else if (n.k === "labeled") stack.push(n.body);
  }
  throw new Error("no loop");
};

// ---------------------------------------------------------------------------
// for-header — 04-for-loop-basic's rotated counting-loop CFG (`countingLoop`,
// docs/lowering/for-loop.md). One caught mutation, one HOLE.
// ---------------------------------------------------------------------------

test("for-header/check rejects a rewrite with the init and step blocks swapped", () => {
  const cfg = countingLoop();
  const fn = structure(cfg);
  const afterLoopCond = applyPasses(fn, [loopCond as Pass<Stmt>], base(cfg));
  const fn2 = afterLoopCond.fn;
  // A writer bug that transposes which block is the init and which is the
  // step (e.g. an operand-order slip building the ForSite).
  const swapInitStep = (m: ForMatch, ctx: PassContext): Stmt => {
    const real = forHeader.rewrite(m, ctx) as Stmt & { k: "loop" };
    const form = real.form!;
    return { ...real, form: { ...form, init: form.step, step: form.init } } as unknown as Stmt;
  };
  const wrapped: Pass<Stmt> = { ...(forHeader as Pass<Stmt>), rewrite: swapInitStep };
  const r = applyPasses(fn2, [wrapped], base(cfg));
  assert.equal(r.applied.length, 0, "the real check must refuse the swapped-block rewrite");
  assert.equal(r.abandoned.length, 1);
  assert.equal(r.abandoned[0]!.pass, "for-header");
  assert.match(r.abandoned[0]!.reason, /init block/);
  assert.equal(r.fn.root, fn2.root, "a refused site leaves the tree untouched");
});

test.todo("HOLE (docs/BUGS.md, 2026-09-01 checker-mutation-stagea row): for-header/check never validates the step block", () => {
  // A writer bug that folds in the wrong step block (or the right block but
  // the wrong instruction offset) leaves `form.init` correct and only
  // corrupts `form.step` — `check` only ever inspects `form.init.cfgBlock`
  // (in the do-while->while promotion branch) and never looks at `form.step`
  // at all, in either branch. Pinned (wrong) verdict, reproduced by hand:
  // `forHeaderCheck(before, { ...real, form: { ...real.form, step: { cfgBlock: 99, from: 0 } } }, ctx)` -> `{ ok: true }`.
  const cfg = countingLoop();
  const fn = structure(cfg);
  const afterLoopCond = applyPasses(fn, [loopCond as Pass<Stmt>], base(cfg));
  const fn2 = afterLoopCond.fn;
  const wrongStep = (m: ForMatch, ctx: PassContext): Stmt => {
    const real = forHeader.rewrite(m, ctx) as Stmt & { k: "loop" };
    const form = real.form!;
    return { ...real, form: { ...form, step: { cfgBlock: 99, from: 0 } } } as unknown as Stmt;
  };
  const wrapped: Pass<Stmt> = { ...(forHeader as Pass<Stmt>), rewrite: wrongStep };
  const r = applyPasses(fn2, [wrapped], base(cfg));
  // Intended (currently failing) assertion — the hole:
  assert.equal(r.applied.length, 0, "the real check should refuse a step pointing at a nonexistent block, but currently accepts it");
});

// ---------------------------------------------------------------------------
// loop-cond — same CFG. Two caught mutations, two HOLEs (same root cause:
// `check` never validates `form.kind`/`form.negate`, only `form.cond`/`.at`).
// ---------------------------------------------------------------------------

test("loop-cond/check rejects a rewrite whose annotated test block is not actually in the tree", () => {
  const cfg = countingLoop();
  const fn = structure(cfg);
  const before = findLoop(fn.root);
  const ctx: PassContext = { ...base(cfg), applied: [], structured: fn, parentOf: () => null };
  const m = loopCond.match(before, ctx);
  assert.ok(m !== null);
  const real = loopCond.rewrite(m, ctx) as Stmt;
  const patchForm = (root: Stmt, patch: object): Stmt =>
    (root.k === "loop" ? { ...root, form: { ...(root as Stmt & { k: "loop" }).form, ...patch } } : root.k === "seq" ? { ...root, body: root.body.map((s) => patchForm(s, patch)) } : root) as unknown as Stmt;
  const wrongCond = patchForm(real, { cond: 99 });
  assert.deepEqual(loopCond.check(before, wrongCond, ctx), { ok: false, reason: "annotated test is not inside the loop" });
});

test("loop-cond/check rejects a rewrite whose test position (`at`) doesn't match the actual guard's position", () => {
  const cfg = countingLoop();
  const fn = structure(cfg);
  const before = findLoop(fn.root);
  const ctx: PassContext = { ...base(cfg), applied: [], structured: fn, parentOf: () => null };
  const m = loopCond.match(before, ctx);
  assert.ok(m !== null);
  const real = loopCond.rewrite(m, ctx) as Stmt;
  const patchForm = (root: Stmt, patch: object): Stmt =>
    (root.k === "loop" ? { ...root, form: { ...(root as Stmt & { k: "loop" }).form, ...patch } } : root.k === "seq" ? { ...root, body: root.body.map((s) => patchForm(s, patch)) } : root) as unknown as Stmt;
  const wrongAt = patchForm(real, { at: "head" });
  const verdict = loopCond.check(before, wrongAt, ctx);
  assert.equal(verdict.ok, false);
});

test.todo("HOLE (docs/BUGS.md, 2026-09-01 checker-mutation-stagea row): loop-cond/check never validates form.kind (while vs do-while)", () => {
  // `match.ts` documents the shape<->kind mapping as deterministic
  // (head -> while, tail(-labeled) -> do-while) but `check` never re-derives
  // or compares `form.kind` at all. Pinned (wrong) verdict, reproduced by
  // hand on countingLoop's real tail-form rewrite (`kind:"do-while"`):
  // flipping to `kind:"while"` (same cond/at/negate) -> `{ ok: true }`.
  const cfg = countingLoop();
  const fn = structure(cfg);
  const before = findLoop(fn.root);
  const ctx: PassContext = { ...base(cfg), applied: [], structured: fn, parentOf: () => null };
  const m = loopCond.match(before, ctx);
  assert.ok(m !== null);
  const real = loopCond.rewrite(m, ctx) as Stmt;
  const patchForm = (root: Stmt, patch: object): Stmt =>
    (root.k === "loop" ? { ...root, form: { ...(root as Stmt & { k: "loop" }).form, ...patch } } : root.k === "seq" ? { ...root, body: root.body.map((s) => patchForm(s, patch)) } : root) as unknown as Stmt;
  const flippedKind = patchForm(real, { kind: "while" });
  // Intended (currently failing) assertion — the hole:
  assert.equal(loopCond.check(before, flippedKind, ctx).ok, false, "the real check should refuse a while/do-while kind flip, but currently accepts it");
});

test.todo("HOLE (docs/BUGS.md, 2026-09-01 checker-mutation-stagea row): loop-cond/check never validates form.negate", () => {
  const cfg = countingLoop();
  const fn = structure(cfg);
  const before = findLoop(fn.root);
  const ctx: PassContext = { ...base(cfg), applied: [], structured: fn, parentOf: () => null };
  const m = loopCond.match(before, ctx);
  assert.ok(m !== null);
  const real = loopCond.rewrite(m, ctx) as Stmt;
  const loopNode = (real.k === "loop" ? real : (real as Stmt & { k: "seq" }).body.find((s) => s.k === "loop"))! as Stmt & { k: "loop" };
  const patchForm = (root: Stmt, patch: object): Stmt =>
    (root.k === "loop" ? { ...root, form: { ...(root as Stmt & { k: "loop" }).form, ...patch } } : root.k === "seq" ? { ...root, body: root.body.map((s) => patchForm(s, patch)) } : root) as unknown as Stmt;
  const flippedNegate = patchForm(real, { negate: !loopNode.form!.negate });
  // Intended (currently failing) assertion — the hole:
  assert.equal(loopCond.check(before, flippedNegate, ctx).ok, false, "the real check should refuse a negate-polarity flip, but currently accepts it");
});

// ---------------------------------------------------------------------------
// if-chain — C1 (else-drop) and C3 (elseIf annotation), hand-built trees per
// docs/specs/passes/09-if-chain.md §4 (neither rule needs a real CFG: C1's
// only CFG use is optional loop/generator refusal context, C3 none).
// ---------------------------------------------------------------------------

function c1Before(): Stmt {
  return { k: "if", cfgBlock: 0, then: { k: "return", cfgBlock: 5 }, else: { k: "seq", body: [{ k: "block", cfgBlock: 1 }, { k: "block", cfgBlock: 2 }] } };
}

test("if-chain/check (C1) rejects a rewrite that drops one of the hoisted else statements", () => {
  const before = c1Before();
  const ctx = bareCtx();
  const m = ifChain.match(before, ctx);
  assert.ok(m !== null && m.data.rule === "C1");
  const real = ifChain.rewrite(m, ctx) as Stmt & { k: "seq" };
  const dropped: Stmt = { ...real, body: real.body.slice(0, -1) };
  assert.deepEqual(ifChain.check(before, dropped, ctx), { ok: false, reason: "else-items-reordered" });
});

test("if-chain/check (C1) rejects a rewrite that reorders the hoisted else statements", () => {
  const before = c1Before();
  const ctx = bareCtx();
  const m = ifChain.match(before, ctx);
  assert.ok(m !== null && m.data.rule === "C1");
  const real = ifChain.rewrite(m, ctx) as Stmt & { k: "seq" };
  const reordered: Stmt = { ...real, body: [real.body[0]!, real.body[2]!, real.body[1]!] };
  assert.deepEqual(ifChain.check(before, reordered, ctx), { ok: false, reason: "else-items-reordered" });
});

test("if-chain/check (C3) rejects annotating elseIf on an else that isn't a chain link", () => {
  const before: Stmt = { k: "if", cfgBlock: 0, then: { k: "block", cfgBlock: 1 }, else: { k: "seq", body: [{ k: "block", cfgBlock: 2 }, { k: "block", cfgBlock: 3 }] } };
  const badAfter: Stmt = { ...before, elseIf: true };
  assert.deepEqual(ifChain.check(before, badAfter, bareCtx()), { ok: false, reason: "not-a-chain-link" });
});

// ---------------------------------------------------------------------------
// switch-raise — the two-level nest from `switch-raise.test.ts`'s own S1
// positive, hand-built (no real CFG needed: `check`'s obligations are all
// structural, re-derived from `before`'s labeled/switch nest).
// ---------------------------------------------------------------------------

function jt(): { t: "jumptable"; table: SwitchTable } {
  return { t: "jumptable", table: {} as SwitchTable };
}
const swBlk = (b: number): Stmt => ({ k: "block", cfgBlock: b });
const swBrk = (l: number): Stmt => ({ k: "break", label: l });
const swSeq = (xs: readonly Stmt[]): Stmt => ({ k: "seq", body: [...xs] });
const swArm = (value: number, body: Stmt): SwitchArm => ({ value, isString: false, body });
const swLab = (l: number, ...body: Stmt[]): Stmt => ({ k: "labeled", label: l, body: body.length === 1 ? body[0]! : swSeq(body) });
type SwitchStmt = Stmt & { k: "switch" };
const mkSwitch = (cases: SwitchArm[], dflt: Stmt): SwitchStmt => ({ k: "switch", cfgBlock: 0, scrutinee: jt(), cases, default: dflt });

function twoLevel(): { node: Stmt; sw: SwitchStmt } {
  const sw = mkSwitch([swArm(0, swSeq([swBlk(1), swBrk(100)])), swArm(1, swBrk(101)), swArm(2, swSeq([swBlk(2), swBrk(101)]))], swSeq([swBlk(3), swBrk(100)]));
  return { node: swLab(100, swLab(101, swBlk(0), sw), swBlk(4), swBrk(100)), sw };
}

test("switch-raise/check rejects mismarking a case's fallThrough (silently drops its fall-through into the next case)", () => {
  const { node } = twoLevel();
  const ctx = bareCtx();
  const m = switchRaise.match(node, ctx);
  assert.ok(m !== null && m.data.rule === "S1");
  const real = switchRaise.rewrite(m, ctx);
  const swNode = (real.k === "switch" ? real : (real as Stmt & { k: "seq" }).body.find((s) => s.k === "switch"))! as SwitchStmt;
  const mutated: SwitchStmt = { ...swNode, cases: swNode.cases.map((c, i) => (i === 0 ? { ...c, fallThrough: false } : c)) };
  const after = (real.k === "switch" ? mutated : { ...real, body: (real as Stmt & { k: "seq" }).body.map((s) => (s === swNode ? mutated : s)) }) as unknown as Stmt;
  assert.deepEqual(switchRaise.check(node, after, ctx), { ok: false, reason: "path-diverged" });
});

test("switch-raise/check rejects an arm's body moved to the wrong case", () => {
  const { node } = twoLevel();
  const ctx = bareCtx();
  const m = switchRaise.match(node, ctx);
  assert.ok(m !== null);
  const real = switchRaise.rewrite(m, ctx);
  const swNode = (real.k === "switch" ? real : (real as Stmt & { k: "seq" }).body.find((s) => s.k === "switch"))! as SwitchStmt;
  const cases = swNode.cases.map((c) => ({ ...c }));
  const tmp = cases[1]!.body;
  cases[1] = { ...cases[1]!, body: cases[2]!.body };
  cases[2] = { ...cases[2]!, body: tmp };
  const mutated: SwitchStmt = { ...swNode, cases };
  const after = (real.k === "switch" ? mutated : { ...real, body: (real as Stmt & { k: "seq" }).body.map((s) => (s === swNode ? mutated : s)) }) as unknown as Stmt;
  const verdict = switchRaise.check(node, after, ctx);
  assert.equal(verdict.ok, false);
});

// ---------------------------------------------------------------------------
// label-clean — L2 (tail-break deletion), hand-built (docs/specs/passes/06-
// label-clean.md; no CFG needed).
// ---------------------------------------------------------------------------

test("label-clean/check rejects a rewrite that leaves a still-referenced break to the removed label", () => {
  const block = (cfgBlock: number): Stmt => ({ k: "block", cfgBlock });
  const brk = (label: number): Stmt => ({ k: "break", label });
  const seq = (body: readonly Stmt[]): Stmt => ({ k: "seq", body });
  const iff = (cfgBlock: number, then: Stmt, els: Stmt): Stmt => ({ k: "if", cfgBlock, then, else: els });
  const labeled = (label: number, body: Stmt): Stmt => ({ k: "labeled", label, body });
  const ctx = bareCtx();
  const body = seq([block(0), iff(1, brk(0), block(2))]);
  const node = labeled(0, body);
  const m = labelClean.match(node, ctx);
  assert.ok(m !== null);
  // A writer bug that reuses `before`'s body verbatim instead of deleting the
  // tail break — the label it's meant to remove is still referenced.
  const mutated = body;
  assert.deepEqual(labelClean.check(node, mutated, ctx), { ok: false, reason: "break-not-in-tail" });
});

// ---------------------------------------------------------------------------
// template-literal — read-as-robust (byte-diff against `applySites(before,
// sites)`), now empirically mutated. T1 hand-built shapes from
// `template-literal.test.ts`'s own T1 positives.
// ---------------------------------------------------------------------------

const assignExpr = (target: Expr, value: Expr): Expr => ({ k: "assign", target, value });
const tlSet = (name: string, value: Expr): AstStmt => ({ k: "expr", expr: assignExpr(id(name), value) });
const tlCall = (callee: Expr, args: readonly Expr[]): Expr => ({ k: "call", callee, args });
const tlMember = (obj: Expr, prop: string): Expr => ({ k: "member", obj, prop: lit(prop), computed: false });
const tlArr = (elements: readonly Expr[]): Expr => ({ k: "array", elements });
const tlStr = (s: string): Expr => lit(JSON.stringify(s));
const tlConcat = (): Expr => tlMember(id("__hbc_HermesInternal"), "concat");
const tlConcatApply = (F: Expr, C0: Expr, args: readonly Expr[]): Expr => tlCall(tlMember(id("Reflect"), "apply"), [F, C0, tlArr(args)]);
function astCtxFor(fnBody: readonly AstStmt[]): PassContext {
  return { analysis: null as unknown as PassContext["analysis"], functionIndex: 0, cfg: {} as PassContext["cfg"], hbcVersion: 94, layoutClass: "hbc94" as PassContext["layoutClass"], applied: [], diagnostic: () => {}, fnBody };
}

test("template-literal/check rejects a rewrite with a wrong literal chunk", () => {
  const before: readonly AstStmt[] = [tlSet("r5", tlConcatApply(tlConcat(), tlStr("Hello, "), [id("r3"), tlStr("!")]))];
  const ctx = astCtxFor(before);
  const m = tlMatch(before, ctx);
  assert.ok(m !== null);
  const real = tlRewrite(m);
  const realExpr = real[0]! as AstStmt & { k: "expr"; expr: { value: Expr & { k: "template" } } };
  const mutated: readonly AstStmt[] = [{ ...real[0]!, expr: { ...realExpr.expr, value: { ...realExpr.expr.value, quasis: ["Goodbye, ", "!"] } } } as AstStmt];
  assert.deepEqual(tlCheck(before, mutated, ctx), { ok: false, reason: "the rewrite is not exactly the derived replacement of the matched sites" });
});

test("template-literal/check rejects a rewrite with substitutions reordered", () => {
  const a1 = id("a1");
  const a2 = id("a2");
  const before: readonly AstStmt[] = [{ k: "return", arg: tlConcatApply(tlConcat(), tlStr(""), [a2, tlStr(":"), a1]) }];
  const ctx = astCtxFor(before);
  const m = tlMatch(before, ctx);
  assert.ok(m !== null);
  const real = tlRewrite(m);
  const realRet = real[0]! as AstStmt & { k: "return"; arg: Expr & { k: "template" } };
  const mutated: readonly AstStmt[] = [{ ...real[0]!, arg: { ...realRet.arg, exprs: [realRet.arg.exprs[1]!, realRet.arg.exprs[0]!] } } as AstStmt];
  assert.deepEqual(tlCheck(before, mutated, ctx), { ok: false, reason: "the rewrite is not exactly the derived replacement of the matched sites" });
});

// ---------------------------------------------------------------------------
// jsx-recover — read-as-robust (byte-diff against `deriveSites`'s own fold),
// now empirically mutated. Shape from `jsx-recover.test.ts`'s automatic-
// runtime positive.
// ---------------------------------------------------------------------------

const jsxMemberFn = (obj: Expr, prop: string): Expr => ({ k: "member", obj, prop: lit(prop), computed: false });
const jsxObj = (props: readonly (readonly [string, Expr])[]): Expr => ({ k: "object", props: props.map(([key, value]) => ({ key, computed: false, value })) });
const jsxStoreTo = (target: Expr, value: Expr): AstStmt => ({ k: "expr", expr: { k: "assign", target, value } });
const jsxStr = (s: string): Expr => lit(JSON.stringify(s));
function automaticSite(): AstStmt[] {
  return [
    tlSet("r10", jsxMemberFn(id("_e0_0"), "jsx")),
    tlSet("r4", id("_e0_2")),
    tlSet("r3", jsxObj([])),
    jsxStoreTo(jsxMemberFn(id("r3"), "style"), id("r6")),
    jsxStoreTo(jsxMemberFn(id("r3"), "children"), jsxStr("hello")),
    tlSet("r8", tlCall(id("r10"), [id("r4"), id("r3")])),
  ];
}

test("jsx-recover/check rejects a rewrite with the wrong JSX tag", () => {
  const before = automaticSite();
  const ctx = astCtxFor(before);
  const m = jsxMatch(before, ctx);
  assert.ok(m !== null);
  const real = jsxRewrite(m);
  const idx = real.findIndex((s) => (s as AstStmt & { k: "expr"; expr: { k: "assign"; value: Expr } }).expr?.value?.k === "jsx");
  const jsxVal = (real[idx] as AstStmt & { k: "expr"; expr: { value: Expr } }).expr.value as Expr & { k: "jsx" };
  const mutated = real.map((s, i) => (i !== idx ? s : ({ ...s, expr: { ...(s as AstStmt & { k: "expr" }).expr, value: { ...jsxVal, tag: id("_e0_9") } } } as AstStmt)));
  assert.deepEqual(jsxCheck(before, mutated, ctx), { ok: false, reason: "the rewrite is not exactly the derived fold of the matched sites" });
});

test("jsx-recover/check rejects a rewrite with a dropped child", () => {
  const before = automaticSite();
  const ctx = astCtxFor(before);
  const m = jsxMatch(before, ctx);
  assert.ok(m !== null);
  const real = jsxRewrite(m);
  const idx = real.findIndex((s) => (s as AstStmt & { k: "expr"; expr: { k: "assign"; value: Expr } }).expr?.value?.k === "jsx");
  const jsxVal = (real[idx] as AstStmt & { k: "expr"; expr: { value: Expr } }).expr.value as Expr & { k: "jsx" };
  const mutated = real.map((s, i) => (i !== idx ? s : ({ ...s, expr: { ...(s as AstStmt & { k: "expr" }).expr, value: { ...jsxVal, children: [] } } } as AstStmt)));
  assert.deepEqual(jsxCheck(before, mutated, ctx), { ok: false, reason: "the rewrite is not exactly the derived fold of the matched sites" });
});
