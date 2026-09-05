// review M5-pass-1 F3 (docs/reviews/M5-pass-1.md, "the emitter can silently
// drop a `for` head's init"): `src/emit/function.ts`'s `lowerItems` trims a
// block that precedes a for-header-annotated loop down to `{ to: init.from }`
// on the assumption `lowerFormedLoop` will print the loop as a `for` and take
// the tail slice as the head's `init`. Not reachable through the shipped
// passes today (for-header's own `check` guarantees the shape it assumed), but
// reachable the moment a second stage-A rung — or, per this batch, a
// synthesised `passes` hook standing in for one — touches an already-formed
// loop and the shape no longer matches. Before the fix, `lowerFormedLoop`'s
// `false` path silently discarded the captured `init` slice; now it is
// printed as a plain statement ahead of the (now plain) `while`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { parseM4 } from "../../support/m4.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import type { FunctionCfg } from "../../../src/cfg/types.ts";
import { emitModule } from "../../../src/emit/index.ts";
import { nodeCheck } from "../../../src/decompile.ts";
import { runPasses } from "../../../src/passes/index.ts";
import { postOrder, splice } from "../../../src/passes/driver.ts";
import type { Stmt, StructuredFunction, WhileForm } from "../../../src/structure/ir.ts";

function fixture(version: number): string {
  return join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", `v${version}.hbc`);
}

test("review M5-pass-1 F3: a for-header loop's init is printed, not dropped, when the loop no longer lowers as a `for`", () => {
  const bytes = new Uint8Array(readFileSync(fixture(94)));
  const { module } = parseM4(bytes);
  const analysis = analyseModule(module, { strictEnv: true });

  const hook = (fn: StructuredFunction, cfg: FunctionCfg) => {
    // Run the real loop-cond + for-header passes first, exactly as the shipped
    // pipeline does, so `form.init` is genuinely earned.
    const real = runPasses(analysis, fn, cfg);
    // Every for-header-annotated loop in this function (there are three in
    // this fixture, one nested inside another): flip `form.at` so
    // `lowerFormedLoop`'s isHead/isTail shape test fails while `form.init`
    // (and `form.step`) survive untouched — precisely the false path the bug
    // was in. Simulates "a second stage-A rung touched an already-formed
    // loop." Labels, not node identity, are the stable key across splices:
    // rewriting an inner loop rebuilds every ancestor on the path to it
    // (`splice` walks the spine), so a node reference captured before that
    // rewrite is stale for any loop that turned out to be its ancestor.
    const isLoopWithInit = (n: Stmt): n is Stmt & { k: "loop" } =>
      n.k === "loop" && n.form !== undefined && (n.form.kind === "while" || n.form.kind === "do-while") && n.form.init !== undefined;
    const targetLabels = postOrder(real.fn.root)
      .filter(isLoopWithInit)
      .map((n) => n.label);
    let root = real.fn.root;
    for (const label of targetLabels) {
      const current = postOrder(root).find((n): n is Stmt & { k: "loop" } => n.k === "loop" && n.label === label)!;
      const form = current.form! as WhileForm;
      const corruptedLoop = { ...current, form: { ...form, at: form.at === "tail" ? ("head" as const) : ("tail" as const) } };
      root = splice(root, current, corruptedLoop);
    }
    return { fn: { ...real.fn, root }, diagnostics: [] };
  };

  const result = emitModule(analysis, { provenanceComments: false, moduleName: "x", passes: hook });

  // The loop no longer prints as a `for` (the annotation's shape assumption
  // failed) …
  assert.doesNotMatch(result.code, /for \(/);
  assert.match(result.code, /while \(/);
  // … but the instructions that were captured as the `for` head's `init` slice
  // must still appear as ordinary statements ahead of the loop, not vanish.
  assert.match(result.code, /r\d+ = 0/);
  const check = nodeCheck(result.code);
  assert.ok(check.ok, check.ok ? "" : check.message);
});
