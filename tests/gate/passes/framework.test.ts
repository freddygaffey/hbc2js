// docs/specs/07-pass-ladder.md §8 invariants PL-01/03/04/05/07/08 on hand-built trees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { emitModule } from "../../../src/emit/index.ts";
import { decompile, parseForDecompile } from "../../../src/decompile.ts";
import { ErrorCode, Hbc2jsError } from "../../../src/errors.ts";
import { printTree, structure } from "../../../src/structure/index.ts";
import type { Stmt } from "../../../src/structure/ir.ts";
import { applyPasses } from "../../../src/passes/driver.ts";
import { enabledPasses, REGISTRY } from "../../../src/passes/registry.ts";
import { forHeader } from "../../../src/passes/for-header/index.ts";
import { loopCond } from "../../../src/passes/loop-cond/index.ts";
import type { LoopSite } from "../../../src/passes/loop-cond/match.ts";
import type { Pass, PassContext } from "../../../src/passes/types.ts";
import { countingLoop, deepFreeze } from "./synth.ts";

type Base = Omit<PassContext, "applied" | "structured" | "parentOf">;
const base = (cfg: ReturnType<typeof countingLoop>): Base => ({ analysis: null as unknown as PassContext["analysis"], functionIndex: 0, cfg, hbcVersion: 94, layoutClass: "hbc94" as PassContext["layoutClass"], diagnostic: () => {} });
const A = [loopCond as Pass<Stmt>, forHeader as Pass<Stmt>];

test("PL-01/PL-08: passes never mutate their input and a second run rewrites nothing", () => {
  const cfg = countingLoop();
  const fn = deepFreeze(structure(cfg));
  const first = applyPasses(fn, A, base(cfg));
  assert.deepEqual(first.applied.map((a) => a.pass), ["loop-cond", "for-header"]);
  assert.match(printTree(first.fn), /L0: loop/);
  const second = applyPasses(deepFreeze(first.fn), A, base(cfg));
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.abandoned, []);
});

test("PL-03: a failed check abandons that site only and leaves the tree untouched", () => {
  const cfg = countingLoop();
  const fn = structure(cfg);
  const refusing: Pass<Stmt> = { ...(loopCond as Pass<Stmt>), check: () => ({ ok: false, reason: "unit test" }) };
  const r = applyPasses(fn, [refusing, forHeader as Pass<Stmt>], base(cfg));
  assert.equal(r.fn.root, fn.root, "the root must be the very same object");
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.abandoned.map((a) => [a.pass, a.reason]), [["loop-cond", "unit test"]]);
  assert.ok(r.diagnostics.some((d) => d.code === "W_PASS_ABANDONED"));
});

test("PL-03: a rewrite that changes the CFG fails the whole-function round-trip and is abandoned", () => {
  const cfg = countingLoop();
  const fn = structure(cfg);
  // Drops the loop test: the back edge disappears.
  const unsound: Pass<Stmt> = { ...(loopCond as Pass<Stmt>), rewrite: (m) => { const d = m.data as LoopSite; return { k: "loop", label: d.loop.label, body: { k: "block", cfgBlock: d.cond } }; }, check: () => ({ ok: true }) };
  const r = applyPasses(fn, [unsound], base(cfg));
  assert.equal(r.fn.root, fn.root);
  assert.equal(r.abandoned.length, 1);
  assert.match(r.abandoned[0]!.reason, /round-trip/);
});

test("PL-04: a pass that throws is E_PASS_CRASH, not a silent skip", () => {
  const cfg = countingLoop();
  const fn = structure(cfg);
  const crashing: Pass<Stmt> = { ...(loopCond as Pass<Stmt>), rewrite: () => { throw new Error("boom"); } };
  assert.throws(() => applyPasses(fn, [crashing], base(cfg)), (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_PASS_CRASH);
});

test("PL-07: registry order must satisfy after/before; skip/only/stage select", () => {
  assert.throws(() => enabledPasses({}, [forHeader as Pass, loopCond as Pass]), (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_PASS_ORDER);
  assert.deepEqual(enabledPasses({ only: ["loop-cond"] }).map((p) => p.name), ["loop-cond"]);
  assert.deepEqual(enabledPasses({ skip: ["for-header"] }).map((p) => p.name), ["loop-cond", "label-clean", "expr-rebuild", "global-access", "call-shape", "fn-naming"]);
  assert.deepEqual(enabledPasses({ stage: "B" }).map((p) => p.name), ["expr-rebuild", "global-access", "call-shape", "fn-naming"]);
  for (const p of REGISTRY) assert.ok(p.catalogue.length > 0, `${p.name} declares no catalogue row`);
});

test("review M5-pass-1 F5: a mistyped only/skip/after/before name is E_PASS_ORDER, not silently ignored", () => {
  assert.throws(() => enabledPasses({ only: ["nonexistent-pass"] }), (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_PASS_ORDER);
  assert.throws(() => enabledPasses({ skip: ["nonexistent-pass"] }), (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_PASS_ORDER);
  const badDep: Pass<Stmt> = { ...(loopCond as Pass<Stmt>), after: ["loop-condd"] };
  assert.throws(() => enabledPasses({}, [badDep, forHeader as Pass]), (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_PASS_ORDER);
});

test("PL-05: --passes=none reproduces the M4 emitter output byte for byte", () => {
  const bytes = new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v94.hbc")));
  const none = decompile(bytes, { passes: { none: true }, moduleName: "x" }).code;
  const { module } = parseForDecompile(bytes);
  const baseline = emitModule(analyseModule(module, { strictEnv: true }), { moduleName: "x", provenanceComments: false, strictEnv: true }).code;
  assert.equal(none, baseline);
  assert.equal((none.match(/while \(true\)/g) ?? []).length, 4);
  const on = decompile(bytes, { moduleName: "x" }).code;
  assert.notEqual(on, none);
  // `call-shape` now folds a `Reflect.apply` this fixture happens to
  // contain (an `Array.prototype.join`-style call), so skipping only the
  // two structural loop passes no longer reproduces the fully-disabled
  // baseline on its own — every stage-B rung has to be skipped too.
  // `label-clean` (re-enabled) also removes this fixture's loop labels, so
  // it must be in the skip list too or `code` keeps `L0:`/`L1:`/… while
  // `none` (the fully-disabled baseline) does not.
  assert.equal(decompile(bytes, { passes: { skip: ["loop-cond", "for-header", "label-clean", "expr-rebuild", "global-access", "call-shape", "fn-naming"] }, moduleName: "x" }).code, none);
});
