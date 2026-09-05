// docs/BUGS.md "whole-file decompile 452 s / 946 s on deb — listIndex
// superlinear" row. `expr-rebuild/match.ts`'s `nextRelevant` replaced an
// eager `byReg`/`jumps` index rebuilt from scratch on every applied site
// (`listIndex`, keyed by the list's own identity, which `spliceList` gives a
// fresh copy of at every site) with a direct bounded scan over the already
// per-node-memoised `stmtInterest` — see that function's own doc comment in
// `src/passes/expr-rebuild/match.ts`. `tests/gate/passes/pipeline-speed.test.ts`
// already pins an *absolute* CPU budget for a single large N (5,000 fold
// sites); this file is the direct scaling proof the bug row's item (1) asks
// for: growing N by 10x should not cost anywhere near 10x more once the
// per-site work is a bounded scan rather than an O(list.length) rebuild.
//
// CPU time, not wall time (`node --test` runs files in parallel, so wall
// time reflects scheduler contention as much as actual work — see
// `pipeline-speed.test.ts`'s own `cpuMs` comment), and a generous ratio
// bound (20x for a 10x growth in N) rather than a tight one: at N=200 fixed
// per-call overhead (module/context setup, JIT warmup) is a much larger
// share of the total than at N=2000, so even a perfectly linear pass does
// not measure as exactly 10x. A pre-fix eager whole-list rebuild per site is
// O(N^2) in this shape (N sites, each rebuilding an O(N)-ish index), so a
// 10x growth in N would cost roughly 100x, not fit inside a 20x budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { timeScale } from "../../support/tiers.ts";
import type { Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { applyAstPasses } from "../../../src/passes/ast.ts";
import { exprRebuild } from "../../../src/passes/expr-rebuild/index.ts";
import type { ModuleView } from "../../../src/passes/tree.ts";
import type { Pass, PassContext } from "../../../src/passes/types.ts";

function fakeModule(): ModuleView {
  return {
    functionCount: 1,
    functionName: (): string => "global",
    isGlobalFunction: (index: number): boolean => index === 0,
    envSlotAccesses: (): readonly { readonly functionIndex: number; readonly offset: number }[] => [],
    depsVerdict: (): null => null,
  };
}

function baseCtx(module: ModuleView): Omit<PassContext, "applied" | "structured" | "parentOf" | "fnBody"> {
  return {
    analysis: null as unknown as PassContext["analysis"],
    functionIndex: 0,
    cfg: {} as PassContext["cfg"],
    hbcVersion: 94,
    layoutClass: "hbc94" as PassContext["layoutClass"],
    diagnostic: () => {},
    module,
  };
}

// `K` independent `rN = <call>; use(rN);` pairs at the top level, cycling
// through a small fixed register alphabet (a real Hermes register file is
// small and linear-scan-allocated, so a module-root function's thousands of
// fold sites reuse the same handful of register names — see
// `pipeline-speed.test.ts`'s `foldCandidateRootBody` for the same shape and
// rationale). Each fold's own forward scan is short-distance by
// construction; the only way this could cost more than O(K) total is an
// eager whole-list rebuild per applied site.
const REGS = 8;
function foldCandidateRootBody(k: number): readonly Stmt[] {
  const body: Stmt[] = [];
  for (let n = 0; n < k; n++) {
    const reg = `r${n % REGS}`;
    body.push({ k: "expr", expr: { k: "assign", target: id(reg), value: { k: "call", callee: id("source"), args: [lit(String(n))] } } });
    body.push({ k: "expr", expr: { k: "call", callee: id("use"), args: [id(reg)] } });
  }
  return body;
}

function cpuMs(f: () => void): number {
  const t0 = process.cpuUsage();
  f();
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000;
}

function runFolds(k: number): number {
  const module = fakeModule();
  const ctx = baseCtx(module);
  const body = foldCandidateRootBody(k);
  return cpuMs(() => {
    const r = applyAstPasses(body, [exprRebuild as unknown as Pass<readonly Stmt[]>], ctx);
    assert.equal(r.abandoned.length, 0, JSON.stringify(r.abandoned.slice(0, 3)));
    assert.equal(r.applied.length, k, "every independent fold site applies");
  });
}

test("expr-rebuild's per-site cost scales close to linearly with site count, not O(sites^2)", () => {
  const small = runFolds(200);
  const large = runFolds(2000);
  // A floor on the small-N measurement keeps the ratio meaningful: if `small`
  // rounds to ~0 ms, any `large` value trivially satisfies a ratio bound
  // without actually proving anything.
  const smallFloored = Math.max(small, 1);
  const ratio = large / smallFloored;
  const budget = 20 * timeScale();
  assert.ok(
    ratio < budget,
    `expr-rebuild CPU time for 2000 sites (${large.toFixed(1)} ms) is ${ratio.toFixed(1)}x the 200-site time (${small.toFixed(1)} ms), a 10x growth in N; budget ${budget.toFixed(1)}x. A pre-fix O(sites^2) rebuild would land near 100x here, not under this budget.`,
  );
});
