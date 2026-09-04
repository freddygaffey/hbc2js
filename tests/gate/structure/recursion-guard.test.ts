// docs/specs/04-structurer.md §4/§8 — the structurer's recursion guard.
//
// Regression for docs/BUGS.md (2026-08-30, "T14 adversarial pass-ladder
// testing", `ramsey`'s `maxDepth`): a *flat* chain of basic blocks with no
// actual nesting used to spend one `doTree` recursion per block, so on a cold
// process it overflowed V8's real call stack with a raw `RangeError` at roughly
// 1000-1075 blocks — hundreds short of the documented 1500-level `maxDepth`
// guard, and with the wrong failure mode (a crash, not a clean E_TOO_COMPLEX).
//
// Why these tests need no `--stack-size` spawn (two earlier attempts to pin the
// bug measured the host's usable stack and each failed CI on a different
// macOS/Node combination — see the BUGS row): nothing asserted here depends on
// how big the host stack is.
//   * The flat-chain cases are stack-independent *because of the fix*: a chain
//     costs one native frame however long it is, so 5000 blocks structure on
//     any stack that can run the test runner at all.
//   * The genuinely-nested case asserts only the failure *mode* — an
//     `Hbc2jsError` with code `E_TOO_COMPLEX`. On a roomy stack that comes from
//     `maxDepth`; on a cramped one it comes from the `RangeError` conversion at
//     `ramsey`'s entry point. Both are the same clean refusal, which is exactly
//     the portable claim the BUGS row asked for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDominators } from "../../../src/cfg/dom.ts";
import type { BasicBlock, BlockId, Edge, FunctionCfg, FunctionKindInfo } from "../../../src/cfg/types.ts";
import { maxNesting } from "../../../src/structure/ir.ts";
import { structure } from "../../../src/structure/index.ts";
import { ErrorCode, Hbc2jsError } from "../../../src/errors.ts";

/** Build a CFG directly against the spec 03 interface. `succs[i]` lists block i's targets. */
function synthCfg(succs: readonly (readonly number[])[]): FunctionCfg {
  const blocks: BasicBlock[] = succs.map((targets, id) => {
    const edges: Edge[] = targets.map((to, k) => ({ from: id, to, kind: targets.length === 1 ? "jump" : k === 0 ? "branch-taken" : "branch-not-taken" }) as Edge);
    return {
      id,
      start: id * 4,
      end: id * 4 + 4,
      instructions: [],
      terminator: targets.length === 0 ? { kind: "return" } : targets.length === 1 ? { kind: "jump" } : { kind: "branch" },
      succs: edges,
      preds: [],
      isHandlerEntry: false,
    };
  });
  const preds: BlockId[][] = blocks.map(() => []);
  for (const b of blocks) for (const e of b.succs) if (!preds[e.to]!.includes(e.from)) preds[e.to]!.push(e.from);
  for (const [i, b] of blocks.entries()) (b as { preds: readonly BlockId[] }).preds = preds[i]!.sort((a, z) => a - z);
  const { rpo, dom, reducible } = computeDominators(blocks, 0, 0);
  const kind: FunctionKindInfo = { functionIndex: 0, kind: "normal", era: "none", evidence: [], innerFunctionIndex: null, trampolineFunctionIndex: null, shimRequired: false };
  return {
    functionIndex: 0,
    blocks,
    entry: 0,
    exits: blocks.filter((b) => b.succs.length === 0).map((b) => b.id),
    byOffset: new Map(blocks.map((b) => [b.start, b.id])),
    exceptionSuccs: new Map(),
    regions: [],
    switchTables: [],
    dom,
    rpo,
    reducible,
    generator: { info: kind, resumeDispatch: null, suspendPoints: [], generatorOps: [] },
    frameSize: 4,
    paramCount: 1,
    diagnostics: [],
  };
}

/** `n` blocks in a straight line, each jumping to the next; the last returns. No nesting at all. */
function flatChain(n: number): FunctionCfg {
  const succs: number[][] = [];
  for (let i = 0; i < n - 1; i++) succs.push([i + 1]);
  succs.push([]);
  return synthCfg(succs);
}

/**
 * `n` levels of genuine nesting: block i branches to i+1 (nesting one level
 * deeper) or to its own private return block, so every level really does cost a
 * `doTree` frame. Blocks 0..n-1 branch, block n returns, blocks n+1..2n are the
 * per-level returns.
 */
function nestedLadder(n: number): FunctionCfg {
  const succs: number[][] = [];
  for (let i = 0; i < n; i++) succs.push([i + 1, n + 1 + i]);
  succs.push([]); // block n — the deepest return
  for (let i = 0; i < n; i++) succs.push([]); // the per-level returns
  return synthCfg(succs);
}

test("a flat chain of 5000 blocks structures cleanly instead of overflowing the call stack", () => {
  const cfg = flatChain(5000);
  assert.equal(cfg.reducible, true);
  // Before the fix this threw a raw `RangeError: Maximum call stack size
  // exceeded` at roughly 1000-1075 blocks. It must now either structure or, at
  // worst, refuse with E_TOO_COMPLEX — never a RangeError.
  let s;
  try {
    s = structure(cfg, { verify: true });
  } catch (e) {
    assert.fail(`flat chain must not fail: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
  assert.equal(s.dispatchVars.length, 0, "a straight line needs no dispatch variable");
  assert.deepEqual(s.duplicatedBlocks, [], "a straight line duplicates nothing");
  // The tree is as flat as the graph: one `seq` of leaves, not 5000 nested ones.
  assert.ok(maxNesting(s.root) <= 4, `flat chain produced nesting ${maxNesting(s.root)}`);
});

test("a flat chain spends no recursion depth: 5000 blocks structure under maxDepth 4", () => {
  // The point of the fix: `maxDepth` counts *nesting*, not blocks. A chain with
  // nothing nested inside it must fit in a handful of levels.
  const s = structure(flatChain(5000), { verify: true, maxDepth: 4 });
  assert.equal(s.stats.blocks, 5000);
});

test("a genuinely nested CFG deeper than maxDepth still refuses with E_TOO_COMPLEX", () => {
  assert.throws(
    () => structure(nestedLadder(50), { verify: true, maxDepth: 10 }),
    (e: unknown) => {
      assert.ok(e instanceof Hbc2jsError, `expected Hbc2jsError, got ${e instanceof Error ? e.name : String(e)}`);
      assert.equal(e.code, ErrorCode.E_TOO_COMPLEX);
      assert.match(e.message, /recursion exceeded 10 levels/);
      return true;
    },
  );
});

test("deep genuine nesting at the default maxDepth refuses cleanly, never with a RangeError", () => {
  // 3000 levels is past the 1500 default. Whichever guard fires first on this
  // host — the depth counter, or the RangeError conversion at ramsey's entry —
  // the caller sees the same clean refusal.
  assert.throws(
    () => structure(nestedLadder(3000), { verify: true }),
    (e: unknown) => {
      assert.ok(!(e instanceof RangeError), "a raw RangeError must never escape the structurer");
      assert.ok(e instanceof Hbc2jsError, `expected Hbc2jsError, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      assert.equal(e.code, ErrorCode.E_TOO_COMPLEX);
      return true;
    },
  );
});
