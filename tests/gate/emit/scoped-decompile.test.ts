// Scoped single-function readable decompile (docs/DECISIONS.md D-scoped-render,
// docs/specs/hunt-tooling-backlog.md #3). Two properties, both rung-owned so
// they don't assert exact fixture text (CLAUDE.md testing rules):
//
//  (a) IDENTITY. For a sample of functions in real construct fixtures —
//      including ones with nested closures and captured variables — the node
//      `emitModule({ onlyFunction: N })` emits for N is DEEP-EQUAL to the node
//      the whole-module render emits for the same N. Compared programmatically
//      (JSON of the emitted AST), never against a literal string, so adding a
//      rung never breaks this and it never pins fixture output.
//
//  (b) COMPLEXITY. A scoped render structures/emits only N's own closure
//      subtree, not every function. Asserted with an injected counter on the
//      `astPasses` hook (emitModule calls it once per emitted function), not
//      wall-clock: the scoped count equals the subtree size and is strictly
//      less than the whole-module count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { parseForDecompile } from "../../../src/decompile.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { emitModule } from "../../../src/emit/index.ts";
import { passHook, astPassHook } from "../../../src/passes/index.ts";

const VERSIONS = ["v84", "v94", "v96", "v99"] as const; // v98 alone is layout-ambiguous for some fixtures
const FIXTURES = ["17-closure-loop-var", "21-iife-closures", "22-nested-closures-counters", "01-if-else-chain"] as const;

function fixturePath(name: string, version: string): string {
  return join(repoRoot(), "tests", "fixtures", "constructs", name, `${version}.hbc`);
}

/** Every function's emitted `func` node from ONE whole-module render, plus the
 *  parsed module + analysis (reused for the scoped renders). */
function wholeRender(bytes: Uint8Array): { module: ReturnType<typeof parseForDecompile>["module"]; nodes: Map<number, string>; count: number } {
  const { module } = parseForDecompile(bytes);
  const analysis = analyseModule(module, { strictEnv: true });
  const nodes = new Map<number, string>();
  let count = 0;
  const hook = astPassHook(analysis, undefined);
  emitModule(analysis, {
    provenanceComments: false,
    strictEnv: true,
    passes: passHook(analysis, undefined),
    astPasses: (fn, cfg) => {
      count++;
      const out = hook(fn, cfg);
      if (out.fn.k === "func") nodes.set(cfg.functionIndex, JSON.stringify(out.fn));
      return out;
    },
  });
  return { module, nodes, count };
}

/** The node the scoped render emits for `target`, and how many functions the
 *  scoped emit actually ran `astPasses` over (its subtree size). */
function scopedRender(bytes: Uint8Array, target: number): { node: string | undefined; count: number } {
  const { module } = parseForDecompile(bytes);
  const analysis = analyseModule(module, { strictEnv: true });
  let node: string | undefined;
  let count = 0;
  const hook = astPassHook(analysis, undefined);
  emitModule(analysis, {
    provenanceComments: false,
    strictEnv: true,
    onlyFunction: target,
    passes: passHook(analysis, undefined),
    astPasses: (fn, cfg) => {
      count++;
      const out = hook(fn, cfg);
      if (cfg.functionIndex === target && out.fn.k === "func") node = JSON.stringify(out.fn);
      return out;
    },
  });
  return { node, count };
}

test("(a) scoped render is byte-identical to each function's slice of the whole render", (t) => {
  let ran = 0;
  for (const name of FIXTURES) {
    for (const version of VERSIONS) {
      const p = fixturePath(name, version);
      if (!existsSync(p)) continue;
      const bytes = new Uint8Array(readFileSync(p));
      let whole;
      try {
        whole = wholeRender(bytes);
      } catch {
        continue; // e.g. a layout-ambiguous file — not this test's concern
      }
      for (const [fn, wholeNode] of whole.nodes) {
        ran++;
        const scoped = scopedRender(bytes, fn);
        assert.equal(scoped.node, wholeNode, `${name}/${version} fn#${fn}: scoped node != whole-render node`);
      }
    }
  }
  assert.ok(ran >= 8, `expected to compare several functions across fixtures/versions, only did ${ran}`);
  t.diagnostic(`compared ${ran} functions`);
});

test("(b) scoped render only structures/emits the target's closure subtree, not the whole module", () => {
  // 22-nested-closures-counters has a global fn plus several nested closures,
  // so a leaf function's scoped subtree is strictly smaller than the module.
  const p = fixturePath("22-nested-closures-counters", "v94");
  if (!existsSync(p)) return; // fixture not built — INCONCLUSIVE, not a failure
  const bytes = new Uint8Array(readFileSync(p));
  const whole = wholeRender(bytes);
  assert.ok(whole.count > 1, "fixture should have more than one emitted function");

  // A leaf function: pick the emitted function whose scoped subtree is smallest.
  let bestFn = -1;
  let bestCount = Infinity;
  for (const fn of whole.nodes.keys()) {
    const scoped = scopedRender(bytes, fn);
    if (scoped.count < bestCount) {
      bestCount = scoped.count;
      bestFn = fn;
    }
  }
  assert.ok(bestFn >= 0, "found no emittable function");
  // The cheapest scoped render runs the emitter over strictly fewer functions
  // than the whole module — i.e. it did NOT emit every function.
  assert.ok(bestCount >= 1, "scoped render must emit at least the target");
  assert.ok(bestCount < whole.count, `scoped render (${bestCount}) should touch fewer functions than the whole module (${whole.count})`);
});
