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
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { applyAstPasses, defUse, expressionOnlyCheck, isPure, registerUses } from "../../../src/passes/ast.ts";
import type { ExprRebuildSite } from "../../../src/passes/expr-rebuild/match.ts";
import { classifySite } from "../../../src/passes/expr-rebuild/match.ts";
import { stmtInterest } from "../../../src/passes/expr-rebuild/stmt-index.ts";
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
const HEAVY_RATIO_REPS = 5;

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
const CLASSIFY_SWEEPS = 40;

/** One timed sweep of `classifySite` over every store in `list`'s site
 *  region. The list is never rewritten here, so the only thing that differs
 *  between the two lists measured below is how much list sits behind the
 *  last site. */
function classifySweep(list: readonly Stmt[], sites: number): void {
  for (let i = 0; i < sites * 2; i += 2) {
    const s = list[i]!;
    assert.equal(s.k, "expr");
    const e = (s as { expr: { k: string; target: { name: string }; value: unknown } }).expr;
    const v = classifySite(list, list, i, e.target.name, e.value as Parameters<typeof classifySite>[4]);
    assert.ok(v.ok, `site ${i} should classify, got ${JSON.stringify(v)}`);
  }
}

test("expr-rebuild's classify layer costs the same per site however long the list behind it is", () => {
  const short = uniqueRegSites(TAIL_SITES, 0);
  const long = uniqueRegSites(TAIL_SITES, INERT_TAIL);
  // Warm: `registerUses` is what the driver hands the matcher after its own
  // first site (`check.ts`'s `noteRegisterUsesSplice`), and one untimed
  // sweep each warms the JIT and the per-node `stmtInterest`/
  // `topLevelReads` memos, which is the steady state the driver sees.
  for (const list of [short, long]) {
    registerUses(list);
    classifySweep(list, TAIL_SITES);
  }
  const batch = (list: readonly Stmt[]): number =>
    cpuMs(() => {
      for (let n = 0; n < CLASSIFY_SWEEPS; n++) classifySweep(list, TAIL_SITES);
    });
  // Interleaved and best-of-N, the same load tolerance the two tests above
  // use: the two halves of each ratio are measured back to back in the same
  // process, so a preemption or a GC pause hits both, and the cheapest of
  // `RATIO_REPS` pairs is the least contaminated one (see `bestOf`).
  let ratio = Infinity;
  let picked = { s: 0, l: 0 };
  for (let n = 0; n < RATIO_REPS; n++) {
    const s = batch(short);
    const l = batch(long);
    const r = l / Math.max(s, 1);
    if (r < ratio) {
      ratio = r;
      picked = { s, l };
    }
  }
  const budget = 4 * timeScale();
  assert.ok(
    ratio < budget,
    `classifying ${TAIL_SITES} sites cost ${picked.l.toFixed(1)} ms with a ${INERT_TAIL}-statement inert tail behind them and ${picked.s.toFixed(1)} ms with none - ${ratio.toFixed(1)}x, budget ${budget.toFixed(1)}x. Cost per site must not depend on list length: a pre-fix isDeadAfter walks that whole tail once per site, which lands near 40x here.`,
  );
});

// ---------------------------------------------------------------------------
// docs/BUGS.md's same superlinear row, part 6: the *classify scan* half.
//
// `classifySite`'s forward search and `isDeadAfter`'s backward scan both step
// through `nextRelevant`, which before this fix walked every statement
// between the site and its answer, asking `stmtInterest` (a WeakMap get plus
// a Set membership test) about each one. On a module-root list that is the
// whole tail: `fn#0` of the Service NSW bundle stores most of its registers
// once, reads them once and never mentions them again, so "the next statement
// that mentions `reg`" is usually "there is none" and every one of its ~4,510
// sites walks to the end of the list. That layer was 275 s of the 546 s CPU
// in the 2026-09-05 whole-file profile of that bundle.
//
// It is now answered from a per-register sorted position list
// (`src/passes/expr-rebuild/stmt-index.ts`), derived across each splice from
// the window `check.ts` has already proven is the only thing that changed.
// `tests/gate/passes/stmt-index.test.ts` proves the answers are identical;
// this is the cost proof.
//
// Self-calibrating, in this file's established style: the denominator is
// literally the work removed - the pre-fix `nextRelevant` scan, reimplemented
// below over the same exported `stmtInterest` facts - measured in the same
// process, on the same list, immediately after the numerator. The pre-fix
// implementation scores >= 1.0 here by construction, since its classify cost
// was exactly this denominator plus everything the numerator still does.

/** K dead stores to distinct registers (never read, never redefined), then a
 *  tail of statements mentioning no register at all: the shape whose
 *  `nextRelevant` answer is always "there is none". */
function deadStoreHeadWithInertTail(k: number, tail: number): readonly Stmt[] {
  const body: Stmt[] = [];
  for (let n = 0; n < k; n++) body.push({ k: "expr", expr: { k: "assign", target: id(`r${n}`), value: { k: "call", callee: id("source"), args: [lit(String(n))] } } });
  for (let n = 0; n < tail; n++) body.push({ k: "expr", expr: { k: "call", callee: id("sink"), args: [lit(String(n))] } });
  return body;
}

function classifyHead(list: readonly Stmt[], k: number): void {
  for (let n = 0; n < k; n++) {
    const s = list[n] as { readonly expr: { readonly value: Expr } };
    classifySite(list, list, n, `r${n}`, s.expr.value);
  }
}

/** The pre-fix `nextRelevant`, kept here as the denominator's reference
 *  implementation only - `stmt-index.ts` no longer scans this way when it
 *  holds an index for the list. One call per site, exactly as
 *  `classifySite`'s forward search made. */
function scanHead(list: readonly Stmt[], k: number): number {
  let found = 0;
  for (let n = 0; n < k; n++) {
    for (let m = n + 1; m < list.length; m++) {
      const it = stmtInterest(list[m]!);
      if (it.jump || it.regs.has(`r${n}`)) {
        found++;
        break;
      }
    }
  }
  return found;
}

test("classifySite's scan for a register that is never mentioned again costs a fraction of the whole-tail walk it replaced", () => {
  const warm = deadStoreHeadWithInertTail(200, 500);
  classifyHead(warm, 200); // JIT warmup, not measured
  scanHead(warm, 200);
  const budget = 0.5;
  // Three repetitions, not `RATIO_REPS`: one repetition of the *denominator*
  // here is 500 walks of a 20,000-statement list, seconds of work on its own.
  const reps = 3;
  for (const tail of [4000, 20000]) {
    const list = deadStoreHeadWithInertTail(500, tail);
    const { indexed, scanned } = bestOf(
      reps,
      () => {
        const fresh = deadStoreHeadWithInertTail(500, tail); // a fresh identity per rep: the index is built inside the timed region, never reused
        return { indexed: cpuMs(() => classifyHead(fresh, 500)), scanned: cpuMs(() => scanHead(list, 500)) };
      },
      (t) => t.indexed / Math.max(t.scanned, 1),
    );
    const ratio = indexed / Math.max(scanned, 1);
    assert.ok(
      ratio < budget,
      `500 classifySite calls over a ${500 + tail}-statement list cost ${indexed.toFixed(1)} CPU ms, ${(ratio * 100).toFixed(0)}% of the ` +
        `${scanned.toFixed(1)} ms the pre-fix nextRelevant walk alone costs for the same 500 sites (budget ${(budget * 100).toFixed(0)}%). ` +
        `The pre-fix algorithm scores >= 100% here by construction.`,
    );
  }
});

/**
 * The same claim as a growth curve, since a ratio at one size cannot
 * distinguish "bounded" from "smaller constant": classifying every site of a
 * module-root-shaped list is `O(N log N)` once the answers come from the
 * index (one build, then a binary search per site) and `Theta(N^2)` when
 * every site walks the tail. Per-site cost is therefore asserted to grow by
 * less than 3x across a 4x growth in N - linear-with-a-log would be ~1.2x,
 * and the pre-fix walk is 4x by construction. The bound is deliberately loose
 * because the index build is `O(N)` work amortised over the N sites of one
 * measurement and because `node --test` runs this file under load; it is
 * still a factor of 1.4 below what a quadratic scan can reach.
 */
test("classifying every site of a module-root-shaped list grows near-linearly in the site count", () => {
  const perSite = (n: number): number => {
    const cost = bestOf(
      RATIO_REPS,
      () => {
        const list = deadStoreHeadWithInertTail(n, n);
        return cpuMs(() => classifyHead(list, n));
      },
      (t) => t,
    );
    return cost / n;
  };
  perSite(500); // warmup
  const small = perSite(2000);
  const large = perSite(8000);
  const growth = large / Math.max(small, 1e-6);
  assert.ok(
    growth < 3,
    `per-site classify cost grew ${growth.toFixed(2)}x from N=2000 (${(small * 1000).toFixed(1)} us/site) to N=8000 (${(large * 1000).toFixed(1)} us/site), a 4x growth in N; budget 3x. A tail-walking scan is 4x here by construction.`,
  );
});
