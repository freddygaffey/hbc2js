// T14 (docs/TASKS.md) — adversarial tests for the M5 pass ladder's own
// match()/rewrite()/check() triples (expr-rebuild, global-access, call-shape,
// loop-cond, for-header) and the structurer's maxDepth/maxExpansion limits.
// Not a rehash of tests/fixtures/adversarial/ (that corpus stresses the M4
// baseline decompiler; this file stresses the *readability rewrites* on top
// of it, per D12's rule that a failing `check` must abandon one site rather
// than emit a wrong rewrite). Six cases, each targeting one specific rewrite
// that could plausibly be wrong:
//
//   1. for-header  — a `continue` that skips the step (defence: real match refuses)
//   2. loop-cond    — a flipped exit polarity (defence: blocksOf multiset catches it)
//   3. expr-rebuild — folding inside a generator frame (defence: match + check both refuse)
//   4. call-shape   — Reflect.construct's new-target duplicating a getter (defence: classifyNode + check both refuse)
//   5. global-access — BUG: a "proven global" register clobbered later in a
//      loop body still gets folded, changing behaviour from the 2nd iteration on
//   6. structure     — the maxDepth=1500 recursion guard does not protect a
//      cold process against a raw V8 stack overflow on this shape (BUG)
//
// Cases 5 and 6 are real, reproducible defects, confirmed by directly
// executing both the pre- and post-rewrite forms (not by diffing against
// Node output for something D14 would explain — see docs/BUGS.md). Per
// docs/AGENT-BRIEF.md's "a bug is never fixed silently and never left
// undocumented" and this task's brief (never edit src/passes/**), both are
// *pinned* here (the test asserts the CURRENT, wrong behaviour) so `npm test`
// stays green; docs/BUGS.md carries the row, and the assertion should be
// flipped to the correct behaviour in the same commit that fixes the pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { id, lit } from "../../../src/emit/ast.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { structure } from "../../../src/structure/index.ts";
import type { Stmt as IrStmt } from "../../../src/structure/ir.ts";
import { EMPTY, seq } from "../../../src/structure/ir.ts";
import { applyPasses } from "../../../src/passes/driver.ts";
import { loopCond } from "../../../src/passes/loop-cond/index.ts";
import { match as loopCondMatch } from "../../../src/passes/loop-cond/match.ts";
import { match as forHeaderMatch } from "../../../src/passes/for-header/match.ts";
import { match as exprRebuildMatch } from "../../../src/passes/expr-rebuild/match.ts";
import { check as exprRebuildCheck } from "../../../src/passes/expr-rebuild/check.ts";
import { classifyNode as callShapeClassify } from "../../../src/passes/call-shape/match.ts";
import { check as callShapeCheck } from "../../../src/passes/call-shape/check.ts";
import { match as globalAccessMatch, isProvenGlobal } from "../../../src/passes/global-access/match.ts";
import { check as globalAccessCheck } from "../../../src/passes/global-access/check.ts";
import { rewrite as globalAccessRewrite } from "../../../src/passes/global-access/rewrite.ts";
import type { Pass, PassContext } from "../../../src/passes/types.ts";
import { addr, imm, insn, reg, synthCfg } from "./synth.ts";

type Base = Omit<PassContext, "applied" | "structured" | "parentOf">;
const base = (cfg: Parameters<typeof structure>[0]): Base => ({ analysis: null as unknown as PassContext["analysis"], functionIndex: 0, cfg, hbcVersion: 94, layoutClass: "hbc94" as PassContext["layoutClass"], diagnostic: () => {} });

// ---------------------------------------------------------------------------
// 1. for-header: a `continue` that skips the step must never be turned into
//    a `for` header, because JS's `continue` inside a `for` body always runs
//    the update expression — the opposite of what this shape's bytecode
//    does. If for-header got this wrong, `for (r1=0; r1<r2; r1++) { if (r3)
//    continue; }` would increment r1 on every pass, when the original only
//    incremented it when r3 was false — an infinite loop could terminate,
//    or vice versa.
// ---------------------------------------------------------------------------

function headLoopCfg(): ReturnType<typeof synthCfg> {
  return synthCfg([
    /*0 pred*/ { succs: [1], insns: [insn("LoadConstZero", reg(1)), insn("LoadConstUInt8", reg(2), imm(10))] },
    /*1 cond*/ { succs: [2, 3], insns: [insn("JLess", addr(8), reg(1), reg(2))] },
    /*2 step*/ { succs: [1], insns: [insn("Inc", reg(1), reg(1))] },
    /*3 exit*/ { succs: [], insns: [insn("Ret", reg(1))] },
  ]);
}

function headLoopCtx(cfg: ReturnType<typeof synthCfg>, loop: IrStmt & { k: "loop" }, outer: IrStmt): PassContext {
  return { ...base(cfg), applied: [], structured: structure(cfg), parentOf: (n) => (n === loop ? { parent: outer, index: 1 } : null) };
}

test("for-header positive control: a trailing (unconditional) continue after the step still forms a `for` header", () => {
  const cfg = headLoopCfg();
  const loop: IrStmt & { k: "loop" } = { k: "loop", label: 0, form: { kind: "while", cond: 1, at: "head", negate: true }, body: seq([{ k: "block", cfgBlock: 2 }, { k: "continue", label: 0 }]) };
  const outer = seq([{ k: "block", cfgBlock: 0 }, loop]);
  const m = forHeaderMatch(loop, headLoopCtx(cfg, loop, outer));
  assert.ok(m !== null, "the control case must actually match, or the refusal below proves nothing");
  assert.equal(m.data.step.cfgBlock, 2);
});

test("for-header vicious case: a mid-body `continue` that SKIPS the step is refused, not silently turned into a for-loop that runs the step on every continue", () => {
  const cfg = headLoopCfg();
  // `if (r3) continue;` — not the last statement, so it bypasses the step
  // block (cfgBlock 2) entirely on the taken branch. A naive matcher keying
  // only on "the loop body's last block looks like a step" would still fire
  // here; the real one must count/position-check every continue first.
  const loop: IrStmt & { k: "loop" } = {
    k: "loop",
    label: 0,
    form: { kind: "while", cond: 1, at: "head", negate: true },
    body: seq([{ k: "if", cfgBlock: 4, then: { k: "continue", label: 0 }, else: EMPTY }, { k: "block", cfgBlock: 2 }]),
  };
  const outer = seq([{ k: "block", cfgBlock: 0 }, loop]);
  const m = forHeaderMatch(loop, headLoopCtx(cfg, loop, outer));
  assert.equal(m, null, "a mid-body continue that skips the step must refuse the for-header rewrite");
});

// ---------------------------------------------------------------------------
// 2. loop-cond: `negate` says which branch of the guard `if` leaves the
//    loop. loop-cond's own check() never re-derives `negate` from the guard
//    (unlike for-header's, which explicitly compares before/after negate) —
//    so this proves what actually stands behind that field: does a flipped
//    `negate` (as a hypothetical future matcher bug would produce) slip
//    through, or does something else catch it?
// ---------------------------------------------------------------------------

function countingLoopCfg(): ReturnType<typeof synthCfg> {
  return synthCfg([
    { succs: [1], insns: [insn("LoadConstZero", reg(1)), insn("LoadConstUInt8", reg(2), imm(10))] },
    { succs: [1, 2], insns: [insn("Inc", reg(1), reg(1)), insn("JLess", addr(-4), reg(1), reg(2))] },
    { succs: [], insns: [insn("Ret", reg(1))] },
  ]);
}

test("loop-cond vicious case: a matcher that computed the exit polarity backwards is still refused (defence found: blocksOf duplication, not a negate re-check)", () => {
  const cfg = countingLoopCfg();
  const fn = structure(cfg);
  // An "unsound" matcher: identical to the real one, except it flips
  // `negate` right before returning, simulating a hypothetical bug in the
  // isContinueTo/isBreakTo polarity computation. Real rewrite() and check()
  // run unmodified.
  const unsoundMatch: typeof loopCondMatch = (node, ctx) => {
    const m = loopCondMatch(node, ctx);
    return m === null ? null : { ...m, data: { ...m.data, negate: !m.data.negate } };
  };
  const unsound: Pass<IrStmt> = { ...(loopCond as Pass<IrStmt>), match: unsoundMatch };
  const r = applyPasses(fn, [unsound], base(cfg));
  assert.equal(r.applied.length, 0, "the flipped-polarity rewrite must not be accepted");
  assert.equal(r.abandoned.length, 1);
  assert.equal(r.abandoned[0]!.pass, "loop-cond");
  // The actual mechanism: flipping `negate` makes `rewrite` replace the
  // CONTINUE branch with `break` (instead of the exit branch), while the
  // captured `exit` (computed by the real, correct classification) still
  // gets hoisted after the loop — duplicating the exit block. It is the
  // driver's block-multiset round-trip that catches this, not loop-cond's
  // own site-local check(), which never inspects `negate` at all. Pin the
  // mechanism so a future change to either check() or blocksOf that removes
  // this (accidental) defence is visible here.
  assert.match(r.abandoned[0]!.reason, /block sequence changed/);
});

// ---------------------------------------------------------------------------
// 3. expr-rebuild: registers inside a v<=96 generator frame are restored by
//    __hbc_makeGenerator across a suspend, so a "dead after this point"
//    register may be read again after a resume — folding it would delete a
//    write a later resume needs. Defence in depth: both match() (never
//    proposes the fold) and check() (independently refuses even if handed a
//    would-be-correct-looking rewrite) must know this.
// ---------------------------------------------------------------------------

const assignExpr = (t: Expr, v: Expr): Expr => ({ k: "assign", target: t, value: v });
const exprStmt = (e: Expr): Stmt => ({ k: "expr", expr: e });
const bin = (op: string, l: Expr, r: Expr): Expr => ({ k: "bin", op, left: l, right: r } as Expr);

function astCtx(fnBody: readonly Stmt[], cfg: PassContext["cfg"]): PassContext {
  return { analysis: null as unknown as PassContext["analysis"], functionIndex: 0, cfg, hbcVersion: 94, layoutClass: "hbc94" as PassContext["layoutClass"], applied: [], diagnostic: () => {}, fnBody };
}

test("expr-rebuild vicious case: a single-def/single-use register that would normally fold (R1a) is refused inside a v<=96 generator frame, by both match and check", () => {
  // r1 = r2 + r3; ...; use(r1) — the textbook R1a shape.
  const before: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), bin("+", id("r2"), id("r3")))), exprStmt({ k: "call", callee: id("use"), args: [id("r1")] })];
  const generatorCfg = { generator: { info: { era: "opcode", kind: "generator" } } } as unknown as PassContext["cfg"];
  const normalCfg = { generator: { info: { era: "opcode", kind: "normal" } } } as unknown as PassContext["cfg"];

  assert.equal(exprRebuildMatch(before, astCtx(before, generatorCfg)), null, "match must refuse the whole function inside a generator frame");
  assert.ok(exprRebuildMatch(before, astCtx(before, normalCfg)) !== null, "control: the same shape folds in an ordinary function");

  // Defence in depth: force the R1a rewrite through as if a future edit to
  // match() dropped the isGeneratorFrame guard, and ask the real check().
  const forcedAfter: readonly Stmt[] = [exprStmt({ k: "call", callee: id("use"), args: [bin("+", id("r2"), id("r3"))] })];
  assert.deepEqual(exprRebuildCheck(before, forcedAfter, astCtx(before, generatorCfg)), { ok: false, reason: "generator-frame" });
  assert.deepEqual(exprRebuildCheck(before, forcedAfter, astCtx(before, normalCfg)), { ok: true });
});

// ---------------------------------------------------------------------------
// 4. call-shape: `Reflect.construct(C, args, C)` means "evaluate C as both
//    the constructor AND the explicit new.target" — two separate property
//    reads if C is a getter-backed member expression. `new (r1.Ctor)(a)`
//    would read the getter only ONCE. Defence in depth: classifyNode (what
//    match() uses) and check() must both refuse when C is not a bare
//    identifier (re-reading an identifier has no getter to double-fire).
// ---------------------------------------------------------------------------

const member = (o: Expr, p: string): Expr => ({ k: "member", obj: o, prop: lit(p), computed: false } as Expr);
const call = (callee: Expr, args: readonly Expr[]): Expr => ({ k: "call", callee, args } as Expr);
const reflect = (name: string): Expr => member(id("Reflect"), name);

test("call-shape vicious case: Reflect.construct(getter, args, SAME getter) as new-target is refused by classifyNode AND by check — folding it would fire a getter twice instead of once", () => {
  const ctorGetter = member(id("r1"), "Ctor");
  const construct = call(reflect("construct"), [ctorGetter, { k: "array", elements: [id("a")] }, member(id("r1"), "Ctor")]);
  assert.deepEqual(callShapeClassify(construct, []), { ok: false, reason: "duplicated-construct-callee" });

  // Control: the identical shape with an *identifier* new-target folds fine
  // (re-reading an identifier is side-effect-free, so no double-fire risk).
  const identConstruct = call(reflect("construct"), [id("C"), { k: "array", elements: [id("a")] }, id("C")]);
  const okVerdict = callShapeClassify(identConstruct, []);
  assert.equal(okVerdict.ok, true);

  // Defence in depth: force the (unsound) rewrite through and ask check().
  const list: readonly Stmt[] = [exprStmt(construct)];
  const forcedAfter: readonly Stmt[] = [exprStmt({ k: "new", callee: ctorGetter, args: [id("a")] } as Expr)];
  assert.deepEqual(callShapeCheck(list, forcedAfter, astCtx(list, {} as PassContext["cfg"])), { ok: false, reason: "duplicated-construct-callee" });
});

// ---------------------------------------------------------------------------
// 5. global-access — BUG. `isProvenGlobal` proves a register global by
//    scanning EVERY write to it across the whole function and requiring
//    exactly one write valued literally `globalThis`, chronologically
//    first. It never checks whether a LATER write (elsewhere in the
//    function) can execute again BEFORE the guarded read on a repeat visit
//    — which is exactly what happens when the guard+read+a later clobber
//    all live in the body of a loop. See docs/BUGS.md (2026-08-30,
//    global-access loop-clobber).
// ---------------------------------------------------------------------------

function guardFor(p: string, g: Expr): Stmt {
  return {
    k: "if",
    test: { k: "unary", op: "!", arg: { k: "bin", op: "in", left: lit(`"${p}"`), right: g } },
    then: [{ k: "throw", arg: { k: "new", callee: id("ReferenceError"), args: [lit(`"Property '${p}' doesn't exist"`)] } }],
    else: [],
  };
}

test("global-access BUG (pinned): a proven-global register clobbered later in a repeating loop body still folds, which is wrong from the 2nd iteration on", () => {
  // r1 = globalThis;
  // while (r2) {
  //   if (!("p" in r1)) throw new ReferenceError("Property 'p' doesn't exist");
  //   r0 = r1.p;      <- global-access wants to fold this to bare `p`
  //   r1 = other;     <- clobbers r1 for the NEXT iteration; same statement
  //                      list as the guard+read, but AFTER the read, so
  //                      classifySite never looks at it before returning ok
  // }
  const loopBody: readonly Stmt[] = [guardFor("p", id("r1")), exprStmt(assignExpr(id("r0"), member(id("r1"), "p"))), exprStmt(assignExpr(id("r1"), id("other")))];
  const whileStmt: Stmt = { k: "while", label: null, test: id("r2"), body: loopBody };
  const fnBody: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), id("globalThis"))), whileStmt];
  const ctx = astCtx(fnBody, {} as PassContext["cfg"]);

  // The unsoundness lives in isProvenGlobal itself: it is whole-function and
  // position-blind, so it says "proven" even though r1 is clobbered by a
  // statement that executes (on the 2nd+ iteration) before the read it is
  // "proving" — pinned here so a fix to isProvenGlobal must touch this test.
  assert.equal(isProvenGlobal(fnBody, id("r1")), true, "current (unsound) behaviour: whole-function write-count proof ignores loop re-entry");

  const m = globalAccessMatch(loopBody, ctx);
  assert.ok(m !== null, "current (wrong) behaviour: the fold is accepted");
  const after = globalAccessRewrite(m);
  assert.deepEqual(globalAccessCheck(loopBody, after, ctx), { ok: true }, "current (wrong) behaviour: check() re-derives the same unsound proof and also accepts it");

  // Confirm the divergence is real by actually running both forms (no
  // Hermes-vs-Node ambiguity here at all: no let-in-loop, no TDZ, no
  // `arguments` — plain property reads under a global write, identical
  // semantics on any ES engine).
  const run = (src: string): string[] => {
    const out: string[] = [];
    const sandbox = { print: (...a: unknown[]) => out.push(String(a[0])) };
    vm.createContext(sandbox);
    vm.runInContext(`globalThis.p = "GLOBAL"; ${src}`, sandbox);
    return out;
  };
  const before = run(`
    let r1, r0, r2, other = { p: "OTHER" };
    r1 = globalThis; r2 = 2;
    while (r2-- > 0) { if (!("p" in r1)) throw new ReferenceError("Property 'p' doesn't exist"); r0 = r1.p; print(r0); r1 = other; }
  `);
  const afterRun = run(`
    let r1, r0, r2, other = { p: "OTHER" };
    r1 = globalThis; r2 = 2;
    while (r2-- > 0) { r0 = p; print(r0); r1 = other; }
  `);
  assert.deepEqual(before, ["GLOBAL", "OTHER"], "the un-rewritten (correct) program: global on iteration 1, `other` on iteration 2");
  assert.deepEqual(afterRun, ["GLOBAL", "GLOBAL"], "current (wrong) rewrite: reads the real global on EVERY iteration -- a genuine behaviour change");
});

// ---------------------------------------------------------------------------
// 6. structurer limits — BUG. `maxDepth` (default 1500, src/structure/index.ts)
//    exists so a pathologically deep recursion refuses cleanly
//    (E_TOO_COMPLEX) instead of crashing. Measured boundary on a cold
//    process (this test file, run alone): a flat chain of ~1030 sequential
//    basic blocks (no actual nesting -- e.g. a huge switch, or thousands of
//    sequential statements each ending in a jump) structures fine; ~1075+
//    overflows Node's real call stack with an uncaught RangeError, NOT the
//    intended E_TOO_COMPLEX -- 400+ short of the documented 1500 limit. See
//    docs/BUGS.md (2026-08-30, structurer maxDepth guard).
// ---------------------------------------------------------------------------


// The structurer maxDepth finding is deliberately NOT pinned by a test here.
// It was, twice, and both attempts failed CI for the platform rather than the
// defect: the first hard-coded a Linux-measured 1000-block chain and blew up on
// macOS/Node 24; the second measured a ladder at runtime and still failed on
// macOS/Node 22.18. The overflow threshold is a property of the host's usable
// V8 stack, not of this code, so any assertion about it is a portability trap.
// The finding is real and is recorded in docs/BUGS.md with both measured
// thresholds; a regression test becomes possible only once the guard is made
// stack-aware, at which point the fix should add one.
