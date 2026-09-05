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
import { applyAstPasses, defUse, expressionOnlyCheck, isPure, registerUses } from "../../../src/passes/ast.ts";
import type { ExprRebuildSite } from "../../../src/passes/expr-rebuild/match.ts";
import { classifySite } from "../../../src/passes/expr-rebuild/match.ts";
import { substituteTopLevel } from "../../../src/passes/expr-rebuild/rewrite.ts";
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

/**
 * Best of `reps`. Every ratio in this file is a *lower bound* claim - the
 * shipped code costs less than X - so the cheapest observation is the least
 * contaminated one, and taking the minimum is sound for exactly that
 * direction: a pre-fix implementation that scores over budget in every
 * repetition still scores over budget at its own minimum, so nothing this
 * file proves is weakened. What it removes is the one-sided noise a
 * *parallel* gate injects: `node --test` runs this file alongside a dozen
 * others, and a preemption or a GC pause landing inside a timed region can
 * only ever inflate a measurement, never deflate it. Measured on this Mac
 * under a full parallel gate (load 12-17), the part-4 ratio below read
 * ~1.5 s against ~160 ms for the same code run alone; best-of-5 brings it
 * back to the alone-value. Added 2026-09-05 with perf part 5, after the
 * orchestrator reported that test failing in every parallel gate run and
 * passing every time it was run on its own.
 */
function bestOf<T>(reps: number, measure: () => T, score: (t: T) => number): T {
  let best = measure();
  for (let n = 1; n < reps; n++) {
    const next = measure();
    if (score(next) < score(best)) best = next;
  }
  return best;
}

const RATIO_REPS = 5;
/** Fewer repetitions where one repetition is itself seconds of work, so the
 *  file stays inside the gate's own time budget. */
const HEAVY_RATIO_REPS = 3;

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

// ---------------------------------------------------------------------------
// docs/BUGS.md's same superlinear row, part 3: `expressionOnlyCheck`'s
// read-before-def half used to run a whole-list `defUse(after)` walk on
// *every* applied site (`O(sites x list.length)` for a module-root-shaped
// function). It is now incremental (`incrementalReadBeforeDef` in
// `src/passes/ast.ts`: per-lineage persistent position keys plus a carried
// "violating" name set, so only the spliced region is walked).
//
// The load-tolerant guard for that is a *self-calibrating ratio*, not an
// N-to-N ratio: both halves are measured in the same process, back to back,
// on the same lists, so a loaded machine slows both equally. The
// denominator is literally the pre-fix algorithm's dominant cost — one
// `defUse(list)` walk per applied site — so the pre-fix implementation
// would score ~1.0 here by construction (it did exactly that walk, plus the
// effect-sequence comparison on top). Measured on this Mac under load
// average 80: 0.18 at 4,000 statements and 0.22 at 8,000.
//
// Note what this test deliberately does *not* claim: that per-site cost is
// constant in list length. `expressionOnlyCheck` still scans in from both
// ends for the reference-identical prefix/suffix (pointer comparisons, the
// same split `registerUseDelta` uses), which is `O(splice position)`, and
// the driver's writer rebuilds the whole immutable statement array per
// applied site (`[...list.slice(0, i), ...list.slice(i + 1)]` in
// `expr-rebuild/rewrite.ts`) — both `O(list.length)` per site by
// construction of the immutable-list architecture, neither one this row's
// `defUse` term. See docs/PUSHBACK.md P-33.

/** A lineage of statement lists, each one the previous with a single
 *  statement replaced by a structurally identical clone (a fresh object, so
 *  the prefix/suffix split sees exactly one changed statement, and the
 *  effect sequence is unchanged so the check reaches its read-before-def
 *  half rather than short-circuiting on effects). Built untimed. */
function spliceLineage(pairs: number, sites: number): readonly (readonly Stmt[])[] {
  const chain: (readonly Stmt[])[] = [foldCandidateRootBody(pairs)];
  for (let s = 0; s < sites; s++) {
    const cur = chain[chain.length - 1]!;
    const p = (2 * s) % cur.length;
    const next = cur.slice();
    next[p] = { ...cur[p]! };
    chain.push(next);
  }
  return chain;
}

function expressionOnlyCheckVsBruteForce(pairs: number, sites: number): { readonly incremental: number; readonly brute: number } {
  const chain = spliceLineage(pairs, sites);
  const incremental = cpuMs(() => {
    for (let s = 0; s < sites; s++) {
      const r = expressionOnlyCheck(chain[s]!, chain[s + 1]!);
      assert.equal(r.ok, true, "a pure clone of one statement is always expression-only");
    }
  });
  const brute = cpuMs(() => {
    for (let s = 0; s < sites; s++) defUse(chain[s + 1]!);
  });
  return { incremental, brute };
}

test("expressionOnlyCheck's read-before-def half costs a fraction of the whole-list defUse walk it replaced, at every list length", () => {
  expressionOnlyCheckVsBruteForce(200, 50); // warmup: JIT, not measured
  const budget = 0.5;
  for (const pairs of [2000, 4000]) {
    const { incremental, brute } = expressionOnlyCheckVsBruteForce(pairs, 500);
    // A floor keeps the ratio meaningful if the denominator rounds to ~0.
    const ratio = incremental / Math.max(brute, 1);
    assert.ok(
      ratio < budget,
      `expressionOnlyCheck over 500 splices of a ${pairs * 2}-statement list cost ${incremental.toFixed(1)} CPU ms, ` +
        `${(ratio * 100).toFixed(0)}% of the ${brute.toFixed(1)} ms the pre-fix whole-list defUse(after) walk alone costs ` +
        `for the same 500 sites (budget ${(budget * 100).toFixed(0)}%). The pre-fix algorithm scores ~100% here by construction.`,
    );
  }
});

// ---------------------------------------------------------------------------
// docs/BUGS.md's same superlinear row, part 4: the *writer and checker* half.
// Before this fix an applied site rebuilt the whole immutable statement array
// four times over - `rewrite` built `[...list.slice(0, i), ...list.slice(i +
// 1)]` (three allocations, ~2x `list.length` element copies) and then, for
// R1a, did it a second time to place the substituted statement, and `check`
// called `rewrite` all over again purely to re-derive an expected `after`
// whose every element outside the touched window was already
// reference-identical to the real one, then compared the two lists
// element-wise. `registerUseDelta` added two more whole-list scans on top to
// rediscover a window the re-classified site already names. That was the
// 6.8 s `rewrite` frame, the 3.9 s `expected.every(sameStmt)` frame and much
// of the 2.7 s of GC in the 8,000-site profile quoted in that row.
//
// Now the writer allocates once and the checker allocates nothing: it
// re-derives the expected element at each position from `before` and the
// re-classified site (`verifyExpectedShape` in `expr-rebuild/check.ts`), and
// `registerUseDelta` gets its window from `i`/`j` directly.
//
// Same self-calibrating shape as the test above: numerator and denominator
// are measured in the same process, on the same lists, interleaved site by
// site, so a loaded machine slows both equally. The denominator is literally
// the work this change removed - the pre-fix writer's build, run twice (once
// for the writer, once for the checker's re-derivation) plus the whole-list
// element-wise comparison - so the pre-fix implementation scores strictly
// *above* 1.0 here by construction, since its total was exactly this
// denominator plus everything the numerator still does.
//
// What this test does NOT claim (docs/PUSHBACK.md P-33, P-34): that per-site
// cost is now constant in list length. The one remaining whole-array build in
// the writer is the floor for an immutable `readonly Stmt[]`, so with sites
// growing in proportion to list length the benchmark is still ~4x for a 2x
// growth in N. Removing that needs a persistent list representation, not
// another memo.

/** The pre-fix writer, kept here as the denominator's reference
 *  implementation only - `expr-rebuild/rewrite.ts` no longer builds lists
 *  this way. Never used to produce a list the checker sees. */
function wholeListRebuild(list: readonly Stmt[], site: ExprRebuildSite): readonly Stmt[] {
  const { rule, i, j, reg, value } = site;
  if (rule === "R1c") return [...list.slice(0, i), ...list.slice(i + 1)];
  if (rule === "R1b") {
    if (isPure(value)) return [...list.slice(0, i), ...list.slice(i + 1)];
    return [...list.slice(0, i), { k: "expr", expr: value } as Stmt, ...list.slice(i + 1)];
  }
  const withoutStore = [...list.slice(0, i), ...list.slice(i + 1)];
  const newJ = j - 1;
  const rewritten = substituteTopLevel(withoutStore[newJ]!, reg, value);
  return [...withoutStore.slice(0, newJ), rewritten, ...withoutStore.slice(newJ + 1)];
}

function sameStmtRef(a: Stmt, b: Stmt): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function cpuSince(t0: NodeJS.CpuUsage): number {
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000;
}

function rewriteAndCheckVsWholeListRebuild(pairs: number, sites: number): { readonly bounded: number; readonly removed: number } {
  const ctxBase = baseCtx(fakeModule());
  let cur = foldCandidateRootBody(pairs);
  let bounded = 0;
  let removed = 0;
  for (let s = 0; s < sites; s++) {
    const ctx = { ...ctxBase, applied: [], fnBody: cur } as unknown as PassContext;
    const m = exprRebuild.match(cur, ctx); // the driver's half, deliberately untimed
    assert.notEqual(m, null, `site ${s} of ${sites} still matches`);
    const t0 = process.cpuUsage();
    const after = exprRebuild.rewrite(m!, ctx);
    const verdict = exprRebuild.check(cur, after, ctx);
    bounded += cpuSince(t0);
    assert.equal(verdict.ok, true, `site ${s}: ${JSON.stringify(verdict)}`);
    const t1 = process.cpuUsage();
    wholeListRebuild(cur, m!.data); // what the writer used to build
    const expected = wholeListRebuild(cur, m!.data); // what the checker used to build again
    const same = expected.length === after.length && expected.every((x, k) => sameStmtRef(x, after[k]!));
    removed += cpuSince(t1);
    assert.equal(same, true, "the reference rebuild agrees with the shipped writer");
    cur = after;
  }
  return { bounded, removed };
}

test("expr-rebuild's writer and checker cost less than the whole-list rebuild-and-compare they replaced, at every list length", () => {
  rewriteAndCheckVsWholeListRebuild(200, 200); // warmup: JIT, not measured
  const budget = 0.8;
  for (const pairs of [1000, 2000]) {
    // Best of `RATIO_REPS` (see `bestOf`): under a loaded parallel gate a
    // single observation of this ratio is dominated by preemption and GC
    // pauses landing in the numerator's timed region, not by the work.
    const { bounded, removed } = bestOf(
      HEAVY_RATIO_REPS,
      () => rewriteAndCheckVsWholeListRebuild(pairs, pairs),
      (r) => r.bounded / Math.max(r.removed, 1),
    );
    // A floor keeps the ratio meaningful if the denominator rounds to ~0.
    const ratio = bounded / Math.max(removed, 1);
    assert.ok(
      ratio < budget,
      `expr-rebuild's rewrite+check over ${pairs} applied sites of a ${pairs * 2}-statement list cost ${bounded.toFixed(1)} CPU ms, ` +
        `${(ratio * 100).toFixed(0)}% of the ${removed.toFixed(1)} ms the two pre-fix whole-list rebuilds plus the whole-list ` +
        `comparison cost on their own for the same sites (budget ${(budget * 100).toFixed(0)}%). The pre-fix implementation ` +
        `scores above 100% here by construction: its total was this denominator plus everything the numerator still does.`,
    );
  }
});

// ---------------------------------------------------------------------------
// docs/BUGS.md's same superlinear row, part 5: the classify/scan layer.
// docs/reports/2026-09-05-nsw-retime.md's `--cpu-prof` of the Service NSW
// whole-file run put `match.ts`'s `classifySite`/`nextRelevant`/`scanFrom`/
// `stmtInterest` at the top after GC, and
// docs/reports/2026-09-05-perf5-match-scan.md reproduced why: for the shape a
// module-root function is made of - a register stored once, read once and
// never mentioned again - `isDeadAfter` ran its liveness scan *first*, and
// that scan has to walk every remaining statement to the end of the list
// before it can conclude anything. One full tail walk per site.
//
// The fix asks D-b's whole-function register counts first whenever that map
// is already memoised (`registerUsesIfMemoised`), which it now always is
// because `check.ts` carries it across each splice. Same two pure
// predicates, same `||`, same verdict - only the evaluation order changes.
//
// The property that proves it is exactly the one the row's remaining scope
// needs: **cost per site independent of list length**. Fixed site count,
// growing inert tail that no site needs to look at (no register mention, no
// jump anywhere in it). Pre-fix this ratio is proportional to the tail
// length (a ~50x growth for the sizes below); post-fix it is flat.
const INERT_TAIL = 20_000;
const TAIL_SITES = 500;

function uniqueRegSites(sites: number, tail: number): readonly Stmt[] {
  const body: Stmt[] = [];
  for (let n = 0; n < sites; n++) {
    const reg = `r${n}`;
    body.push({ k: "expr", expr: { k: "assign", target: id(reg), value: { k: "call", callee: id("source"), args: [lit(String(n))] } } });
    body.push({ k: "expr", expr: { k: "call", callee: id("use"), args: [id(reg)] } });
  }
  for (let n = 0; n < tail; n++) body.push({ k: "expr", expr: { k: "call", callee: id("inert"), args: [lit(String(n))] } });
  return body;
}

/** Time `classifySite` over every store in `list`'s site region, with the
 *  whole-function register map already warm - which is the state the driver
 *  always hands the matcher after its first site (see `check.ts`'s
 *  `noteRegisterUsesSplice`). The list itself is never rewritten here, so
 *  the *only* thing that differs between the two measurements is how much
 *  list sits behind the last site. */
const CLASSIFY_SWEEPS = 100;

function classifyAll(sites: number, tail: number): number {
  const list = uniqueRegSites(sites, tail);
  registerUses(list);
  const sweep = (): void => {
    for (let i = 0; i < sites * 2; i += 2) {
      const s = list[i]!;
      assert.equal(s.k, "expr");
      const e = (s as { expr: { k: string; target: { name: string }; value: unknown } }).expr;
      const v = classifySite(list, list, i, e.target.name, e.value as Parameters<typeof classifySite>[4]);
      assert.ok(v.ok, `site ${i} should classify, got ${JSON.stringify(v)}`);
    }
  };
  sweep(); // untimed: warms JIT and the per-node `stmtInterest`/`topLevelReads` memos, which is the steady state the driver sees
  // Best of `RATIO_REPS` batches over the very same list (see `bestOf`):
  // both sides of the ratio are measured this way, so neither is favoured.
  return bestOf(
    RATIO_REPS,
    () =>
      cpuMs(() => {
        for (let n = 0; n < CLASSIFY_SWEEPS; n++) sweep();
      }),
    (t) => t,
  );
}

test("expr-rebuild's classify layer costs the same per site however long the list behind it is", () => {
  const short = classifyAll(TAIL_SITES, 0);
  const long = classifyAll(TAIL_SITES, INERT_TAIL);
  const ratio = long / Math.max(short, 1);
  const budget = 4 * timeScale();
  assert.ok(
    ratio < budget,
    `classifying ${TAIL_SITES} sites cost ${long.toFixed(1)} ms with a ${INERT_TAIL}-statement inert tail behind them and ${short.toFixed(1)} ms with none - ${ratio.toFixed(1)}x, budget ${budget.toFixed(1)}x. Cost per site must not depend on list length: a pre-fix isDeadAfter walks that whole tail once per site, which lands near 50x here.`,
  );
});
