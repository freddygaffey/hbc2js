// loop-cond / for-header: unit tests on hand-built trees (1 positive, ≥2
// negative, 1 abandonment — spec 07 §10) and the red→green fixtures 02/03/04
// at every version, plus their .obf variants through the equivalence harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import { hbc2jsDecompiler, runTier } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";
import { seq, structure } from "../../../src/structure/index.ts";
import type { Stmt } from "../../../src/structure/ir.ts";
import { applyPasses } from "../../../src/passes/driver.ts";
import { forHeader } from "../../../src/passes/for-header/index.ts";
import { loopCond } from "../../../src/passes/loop-cond/index.ts";
import type { Pass, PassContext } from "../../../src/passes/types.ts";
import { addr, countingLoop, insn, reg, synthCfg } from "./synth.ts";

type Base = Omit<PassContext, "applied" | "structured" | "parentOf">;
const base = (cfg: ReturnType<typeof countingLoop>): Base => ({ analysis: null as unknown as PassContext["analysis"], functionIndex: 0, cfg, hbcVersion: 94, layoutClass: "hbc94" as PassContext["layoutClass"], diagnostic: () => {} });
const ctxFor = (cfg: ReturnType<typeof countingLoop>, fn: ReturnType<typeof structure>): PassContext => ({ ...base(cfg), applied: [], structured: fn, parentOf: () => null });
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

test("positive: the rotated counting loop becomes `for (r1 = 0, r2 = 10; r1 < r2; r1++)`", () => {
  const cfg = countingLoop();
  const fn = structure(cfg);
  const r = applyPasses(fn, [loopCond as Pass<Stmt>, forHeader as Pass<Stmt>], base(cfg));
  const loop = findLoop(r.fn.root);
  assert.deepEqual(loop.form, { kind: "while", cond: 1, at: "tail", negate: false, init: { cfgBlock: 0, from: 0 }, step: { cfgBlock: 1, from: 0 } });
  // The exit was hoisted after the loop and the guard's exit branch is now `break`.
  assert.equal(r.fn.root.k, "seq");
  const body = (r.fn.root as Stmt & { k: "seq" }).body;
  assert.equal(body[body.length - 1]!.k, "return");
  const guard = (loop.body as Stmt & { k: "seq" }).body[1] as Stmt & { k: "if" };
  assert.deepEqual(guard.else, { k: "break", label: loop.label });
});

test("negative: a second `continue` to the loop refuses (a do-while continue would skip to the test)", () => {
  const cfg = countingLoop();
  const fn = structure(cfg);
  const loop = findLoop(fn.root);
  const extra: Stmt = { ...loop, body: seq([{ k: "continue", label: loop.label }, ...((loop.body as Stmt & { k: "seq" }).body)]) };
  assert.equal(loopCond.match(extra, ctxFor(cfg, fn)), null);
});

test("negative: a test that is not a register compare refuses", () => {
  const cfg = synthCfg([
    { succs: [1], insns: [insn("LoadConstZero", reg(1))] },
    { succs: [1, 2], insns: [insn("Inc", reg(1), reg(1)), insn("JmpBuiltinIs", addr(-4), reg(1), reg(2))] },
    { succs: [], insns: [insn("Ret", reg(1))] },
  ]);
  const fn = structure(cfg);
  assert.equal(loopCond.match(findLoop(fn.root), ctxFor(cfg, fn)), null);
});

test("negative: for-header refuses when the preceding block does not write the test's registers", () => {
  const cfg = synthCfg([
    { succs: [1], insns: [insn("LoadConstZero", reg(3))] },
    { succs: [1, 2], insns: [insn("Inc", reg(1), reg(1)), insn("JLess", addr(-4), reg(1), reg(2))] },
    { succs: [], insns: [insn("Ret", reg(1))] },
  ]);
  const fn = structure(cfg);
  const r = applyPasses(fn, [loopCond as Pass<Stmt>, forHeader as Pass<Stmt>], base(cfg));
  assert.deepEqual(r.applied.map((a) => a.pass), ["loop-cond"]);
  assert.equal(findLoop(r.fn.root).form?.kind, "do-while", "r1/r2 are unknown at entry: no first-test proof, so no while/for");
});

test("abandonment: a site whose check fails is left as the M4 shape", () => {
  const cfg = countingLoop();
  const fn = structure(cfg);
  const refusing: Pass<Stmt> = { ...(loopCond as Pass<Stmt>), check: () => ({ ok: false, reason: "no" }) };
  const r = applyPasses(fn, [refusing, forHeader as Pass<Stmt>], base(cfg));
  assert.equal(findLoop(r.fn.root).form, undefined);
  assert.equal(r.abandoned.length, 1);
});

const fixture = (name: string, file: string): Uint8Array => new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, file)));
const VERSIONS = [84, 94, 96, 98, 99];
const EXPECT: Record<string, RegExp> = {
  "02-while-loop": /while \(/,
  "03-do-while-loop": /do \{/,
  "04-for-loop-basic": /for \(/,
};

for (const [name, want] of Object.entries(EXPECT)) {
  test(`${name}: every version prints ${want.source.replace(/\\/g, "")} and no while (true)`, () => {
    for (const v of VERSIONS) {
      const code = decompile(fixture(name, `v${v}.hbc`), { resolveV98Ambiguity: true, moduleName: name }).code;
      assert.match(code, want, `v${v}`);
      assert.doesNotMatch(code, /while \(true\)/, `v${v} still has a while (true)`);
    }
  });
}

test("the .obf variants of 02/03/04 stay PASS with passes on (flattened control flow must not be mis-matched)", async () => {
  const only = Object.keys(EXPECT).map((n) => `${n}.obf`);
  // `.obf` variants live in the hardened tier (D13/D16 C4), not the gate.
  const report = await runTier({ tier: "hardened", decompiler: hbc2jsDecompiler, only });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS).map((r) => `${r.fixture.name}: ${r.verdict}`);
  assert.deepEqual(bad, []);
  assert.ok(report.summary.pass >= 12, `only ${report.summary.pass} .obf checks ran`);
});
