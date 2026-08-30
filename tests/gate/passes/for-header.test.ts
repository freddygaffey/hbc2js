// docs/reviews/M5-pass-1.md F2, F4 (carried over by
// docs/specs/passes/01-framework-fixes.md §9): for-header had no test file of
// its own (F8 of that review), and no test anywhere had ever made a *real*
// `check` return `ok: false` — both shipped abandonment tests substituted a
// stub `check` instead. This file plugs both gaps, plus the mirror for
// `loop-cond/check.ts` and a differential (run-it, don't re-assert-the-
// -predicate) test for `firstTestHolds`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import { hbc2jsDecompiler, runTier } from "../../../src/harness/tiers.ts";
import { structure } from "../../../src/structure/index.ts";
import type { Stmt } from "../../../src/structure/ir.ts";
import { seq } from "../../../src/structure/ir.ts";
import { applyPasses } from "../../../src/passes/driver.ts";
import { forHeader } from "../../../src/passes/for-header/index.ts";
import type { ForMatch } from "../../../src/passes/for-header/match.ts";
import { check as loopCondCheck } from "../../../src/passes/loop-cond/check.ts";
import { loopCond } from "../../../src/passes/loop-cond/index.ts";
import type { Pass, PassContext } from "../../../src/passes/types.ts";
import { addr, imm, insn, reg, synthCfg } from "./synth.ts";

type Base = Omit<PassContext, "applied" | "structured" | "parentOf">;
const base = (cfg: ReturnType<typeof synthCfg>): Base => ({ analysis: null as unknown as PassContext["analysis"], functionIndex: 0, cfg, hbcVersion: 94, layoutClass: "hbc94" as PassContext["layoutClass"], diagnostic: () => {} });
const ctxFor = (cfg: ReturnType<typeof synthCfg>, fn: ReturnType<typeof structure>): PassContext => ({ ...base(cfg), applied: [], structured: fn, parentOf: () => null });
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

/** `r1 = 20; r2 = 10; do { r1++ } while (r1 < r2)`: the same shape
 *  `countingLoop()` uses, but the pre-test is statically **false**
 *  (20 < 10), so the loop is genuinely a do-while (runs its body once,
 *  regardless) and must never be promoted to a `for`/`while`. */
function falseFirstTestLoop(): ReturnType<typeof synthCfg> {
  return synthCfg([
    { succs: [1], insns: [insn("LoadConstUInt8", reg(1), imm(20)), insn("LoadConstUInt8", reg(2), imm(10))] },
    { succs: [1, 2], insns: [insn("Inc", reg(1), reg(1)), insn("JLess", addr(-4), reg(1), reg(2))] },
    { succs: [], insns: [insn("Ret", reg(1))] },
  ]);
}

test("F2(a): a do-while whose first test is statically false stays a do-while (loop-cond applies, for-header does not)", () => {
  const cfg = falseFirstTestLoop();
  const fn = structure(cfg);
  const r = applyPasses(fn, [loopCond as Pass<Stmt>, forHeader as Pass<Stmt>], base(cfg));
  assert.deepEqual(r.applied.map((a) => a.pass), ["loop-cond"]);
  const loop = findLoop(r.fn.root);
  assert.equal(loop.form?.kind, "do-while", "20 < 10 is false: no first-test proof, so no while/for");
});

test("F2(b): a for-header match that omits the firstTestHolds proof is still refused by the real check", () => {
  const cfg = falseFirstTestLoop();
  const fn = structure(cfg);
  const afterLoopCond = applyPasses(fn, [loopCond as Pass<Stmt>], base(cfg));
  assert.deepEqual(afterLoopCond.applied.map((a) => a.pass), ["loop-cond"]);
  const fn2 = afterLoopCond.fn;

  // A for-header variant whose `match` promotes a do-while unconditionally,
  // never proving `firstTestHolds` — exactly the proof the real `match`
  // makes and this one skips. Real `rewrite`/`check`, unmodified.
  const unsoundMatch = (node: Stmt, ctx: PassContext): ForMatch | null => {
    if (node.k !== "loop" || node.form === undefined || node.form.kind !== "do-while" || node.form.init !== undefined) return null;
    const at = ctx.parentOf?.(node);
    if (!at || (at.parent as Stmt).k !== "seq") return null;
    const pred = (at.parent as Stmt & { k: "seq" }).body[at.index - 1];
    if (pred === undefined || pred.k !== "block") return null;
    const start = ctx.structured?.graph.blocks[node.form.cond]?.block?.start ?? 0;
    return { root: node, nodes: [node], data: { loop: node, init: { cfgBlock: pred.cfgBlock, from: 0 }, step: { cfgBlock: node.form.cond, from: 0 }, promoted: true }, at: { functionIndex: ctx.functionIndex, offset: start } };
  };
  const unsound: Pass<Stmt> = { ...(forHeader as Pass<Stmt>), match: unsoundMatch };

  const r = applyPasses(fn2, [unsound], base(cfg));
  assert.equal(r.applied.length, 0, "the real check must refuse the site, not accept the unsound match's promotion");
  assert.equal(r.abandoned.length, 1);
  assert.equal(r.abandoned[0]!.pass, "for-header");
  assert.match(r.abandoned[0]!.reason, /statically-true first test/);
  assert.equal(r.fn.root, fn2.root, "a refused site leaves the tree untouched — the very same object");
});

test("mirror: loop-cond's real check refuses a head-form site whose test block carries straight-line instructions", () => {
  // Same block shape loop-cond's real `matchHead` would build a site from,
  // except block 1 (the head test) holds a straight-line instruction ahead
  // of the jump — the one thing a head-form test block must not have,
  // because it has nowhere to print inside `while (cond)`. `match` itself
  // already refuses this shape; this test bypasses match to reach the real
  // `check`, so the refusal is provably the checker's own, not the matcher's.
  const cfg = synthCfg([
    { succs: [1], insns: [] },
    { succs: [1, 2], insns: [insn("LoadConstUInt8", reg(3), imm(5)), insn("JLess", addr(8), reg(1), reg(2))] },
    { succs: [], insns: [insn("Ret", reg(1))] },
  ]);
  const fn = structure(cfg);
  const before: Stmt = {
    k: "loop",
    label: 0,
    body: seq([
      { k: "block", cfgBlock: 1 },
      { k: "if", cfgBlock: 1, then: { k: "break", label: 0 }, else: { k: "seq", body: [{ k: "block", cfgBlock: 1 }, { k: "continue", label: 0 }] } },
    ]),
  };
  const after: Stmt = { ...before, form: { kind: "while", cond: 1, at: "head", negate: true } };
  const verdict = loopCondCheck(before, after, ctxFor(cfg, fn));
  assert.deepEqual(verdict, { ok: false, reason: "head test block has straight-line instructions" });
});

test("F4: firstTestHolds is verified by actually running both loop shapes, not by re-asserting the predicate", async () => {
  // 04-for-loop-basic's rotated counting loop has a statically-true first
  // test and is promoted to `for`; 03-do-while-loop's is a genuine do-while
  // (no provable first test) and must stay `do…while`. Both differ in what
  // gets *printed*; the real assertion here is that both, run for real
  // against the equivalence oracle, still PASS — i.e. the decision in each
  // direction produces correct runtime behaviour, not just the predicate
  // hbc2js's own `firstTestHolds` returns.
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, only: ["04-for-loop-basic", "03-do-while-loop"] });
  const bad = report.results.filter((r) => r.verdict !== "PASS").map((r) => `${r.fixture.name}: ${r.verdict}`);
  assert.deepEqual(bad, []);
  assert.ok(report.summary.pass >= 10, `expected both fixtures at all 5 versions to run, got ${report.summary.pass}`);

  const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, "v94.hbc")));
  const forCode = decompile(fixture("04-for-loop-basic"), { moduleName: "x" }).code;
  const doWhileCode = decompile(fixture("03-do-while-loop"), { moduleName: "x" }).code;
  assert.match(forCode, /for \(/, "the statically-true first test was actually promoted");
  assert.match(doWhileCode, /do \{/, "the unprovable first test actually stayed a do-while");
});
