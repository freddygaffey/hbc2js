// docs/PUSHBACK.md P-1 — the M5 pass pipeline was ~250x slower than the
// baseline on a real bundle (`decompile()` of rn-template: 726 ms with passes
// off, >180 s with them on). Root cause: `fn-naming` renamed one `_fnN` per
// driver iteration and re-classified every candidate — each with whole-body
// walks — after every splice, O(K²·B) per function (fn#0 of rn-template has
// K=439 module factories over a 6 MB body). Secondary terms: `expr-rebuild`'s
// whole-body `identUses` per candidate per iteration, `label-clean`'s
// whole-tree `hasGeneratorDispatch` per node per iteration, and both stage-B
// checkers' `JSON.stringify` of every prefix statement per check.
//
// Two guards: a deterministic regression test pinning the batched
// `fn-naming` match (fails before the fix: the match carried one rename),
// with a generous wall-clock bound that the pre-fix O(K²·B) cannot meet, and
// the pipeline ratio on the committed rn-template bundle itself — the only
// committed fixture with a function shaped like a real app's global
// function. Ratio, not seconds: the bound holds on a slow CI runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { timeScale } from "../../support/tiers.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { applyAstPasses } from "../../../src/passes/ast.ts";
import { fnNaming } from "../../../src/passes/fn-naming/index.ts";
import { match } from "../../../src/passes/fn-naming/match.ts";
import type { ModuleView } from "../../../src/passes/tree.ts";
import type { Pass, PassContext } from "../../../src/passes/types.ts";

// ---------------------------------------------------------------------------
// fn-naming: one match carries every rename (the P-1 root cause).
// ---------------------------------------------------------------------------

function fakeModule(names: readonly string[]): ModuleView {
  return {
    functionCount: names.length,
    functionName: (index: number): string => names[index] ?? "",
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

/** A global-function-shaped body: `K` module factories `_fn1.._fnK`, each a
 *  `func` statement with a small body that also references itself (the
 *  recursive self-reference `rewrite` must follow into the nested body), and
 *  one `__d(_fnN, N)` call per factory — the shape hermesc gives a React
 *  Native bundle's top level. */
function bundleShapedBody(k: number): { readonly body: readonly Stmt[]; readonly names: readonly string[] } {
  const names: string[] = ["global"];
  const body: Stmt[] = [];
  for (let n = 1; n <= k; n++) {
    names.push(`module${n}`);
    body.push({
      k: "func",
      name: `_fn${n}`,
      params: ["g", "r"],
      body: [
        { k: "decl", kind: "let", names: ["r0", "r1"] },
        { k: "expr", expr: { k: "assign", target: id("r0"), value: { k: "call", callee: id("r"), args: [lit(String(n))] } } },
        { k: "expr", expr: { k: "assign", target: id("r1"), value: { k: "member", obj: id("r0"), prop: lit("default"), computed: false } } },
        { k: "if", test: { k: "bin", op: "===", left: id("r1"), right: lit("undefined") }, then: [{ k: "return", arg: { k: "call", callee: id(`_fn${n}`), args: [id("g"), id("r")] } }], else: [] },
        { k: "return", arg: id("r1") },
      ],
    });
    body.push({ k: "expr", expr: { k: "call", callee: id("__d"), args: [id(`_fn${n}`), lit(String(n))] } });
  }
  return { body, names };
}

test("P-1: one fn-naming match carries every qualifying rename in the root list, not just the first", () => {
  const { body, names } = bundleShapedBody(5);
  const module = fakeModule(names);
  const ctx: PassContext = { ...baseCtx(module), applied: [], fnBody: body };
  const m = match(body, ctx);
  assert.ok(m !== null);
  assert.deepEqual(
    m.data.renames.map((r) => [r.n, r.from, r.to]),
    [
      [1, "_fn1", "module1"],
      [2, "_fn2", "module2"],
      [3, "_fn3", "module3"],
      [4, "_fn4", "module4"],
      [5, "_fn5", "module5"],
    ],
  );
  assert.equal(m.at.offset, 0, "the site offset is the first renamed statement");
});

test("P-1: fn-naming on a global-function-shaped body with 600 module factories is one applied site and finishes in linear time", () => {
  const { body, names } = bundleShapedBody(600);
  const module = fakeModule(names);
  const t0 = performance.now();
  const r = applyAstPasses(body, [fnNaming as Pass<readonly Stmt[]>], baseCtx(module));
  const ms = performance.now() - t0;
  assert.equal(r.abandoned.length, 0, JSON.stringify(r.abandoned.slice(0, 3)));
  assert.equal(r.applied.length, 1, "the whole batch is one site");
  const renamed = r.body.filter((s) => s.k === "func" && /^module\d+$/.test(s.name)).length;
  assert.equal(renamed, 600);
  assert.equal(JSON.stringify(r.body).includes("_fn"), false, "no _fnN reference survives, including the recursive self-references");
  // Before the fix this shape took O(K²·B): 600 driver iterations, each
  // re-classifying 600 candidates with two whole-body walks apiece, plus a
  // whole-body print per check — well over a minute. The bound is loose on
  // purpose (CI runners are slow); it is the order of magnitude that matters.
  const budget = 3000 * timeScale();
  assert.ok(ms < budget, `fn-naming took ${ms.toFixed(0)} ms on 600 factories (budget ${budget} ms)`);
});

// ---------------------------------------------------------------------------
// The pipeline ratio on the committed bundle.
// ---------------------------------------------------------------------------

/** CPU milliseconds this process spent in `f` (user + system). `node --test`
 *  runs test files in parallel processes, so wall-clock here measures how
 *  starved this process was by the others as much as anything — in one full
 *  gate run this test's wall time went from 4 s to 43 s. CPU time is what
 *  the other processes cannot inflate. */
function cpuMs(f: () => void): number {
  const t0 = process.cpuUsage();
  f();
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000;
}

test("P-1: on rn-template, decompiling with every pass on costs at most 12x passes-off (was >250x)", () => {
  const bytes = new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc")));
  const time = (passesOn: boolean): number =>
    cpuMs(() => {
      const r = decompile(bytes, { passes: passesOn ? {} : { none: true }, analysis: { strictEnv: false }, verify: false, resolveV98Ambiguity: true });
      assert.equal(r.module.functions.length, 4199);
    });
  // off, on, off: the second `off` has the JIT as warm as `on` had it, so
  // taking the faster `off` never flatters the ratio.
  const off1 = time(false);
  const on = time(true);
  const off2 = time(false);
  const off = Math.min(off1, off2);
  const ratio = on / off;
  // Measured 2026-08-31 (M2 Mac, alone): off ≈ 560 ms, on ≈ 3.1 s, ratio ≈ 5.5.
  // Before the fix `on` did not finish inside 180 s (>250x). 12x leaves room
  // for noise on a shared runner without letting a quadratic term back in.
  assert.ok(ratio <= 12, `passes-on/passes-off CPU ratio ${ratio.toFixed(1)} (on ${on.toFixed(0)} ms, off ${off.toFixed(0)} ms) exceeds 12x`);
  const absolute = 30_000 * timeScale();
  assert.ok(on < absolute, `passes-on decompile took ${on.toFixed(0)} CPU ms (budget ${absolute} ms)`);
});
