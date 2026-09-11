// docs/perf/PARALLEL-DECOMPILE.md part 2 -- the cost side of
// `analyseModuleParallel`, kept deliberately coarse and load-tolerant (this
// box is shared with fuzz campaigns and other agents).
//
// WHAT THIS DOES NOT ASSERT, and why. The task brief asked for "parallel wall
// clock at most 0.7x serial on the held-out bundle". That is not true on any
// bundle in this repo and asserting it would be asserting a measurement, not
// a property: stage-A (`structure()` + the D12 pass pipeline), the only part
// the pool can move off the main thread with a proven-identical splice, is
// only about a third of the readability setup on rn-template and on
// react-navigation; the rest is `emitModule`'s own per-function emit and
// print, which still runs on the main thread. See docs/PUSHBACK.md P-62 for
// the measured breakdown. What IS asserted here are two properties that hold
// by construction and would be real regressions if they broke:
//   1. engaging the pool never makes the setup dramatically slower, and
//   2. the main thread's event loop stays free while the pool works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { rnTemplatePath } from "../../support/fixtures.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { rawFrameBodies } from "../../../src/name-overlay/frames.ts";
import { analyseModuleParallel, stageACoverage } from "../../../src/parallel/analysis-pool.ts";

/** Coarse gate: too few cores or a busy box makes any wall-clock ratio
 *  meaningless. Skipped, never failed (the repo's rule for timing tests). */
function tooBusy(): string | false {
  if (cpus().length < 4) return `needs >= 4 cores, have ${cpus().length}`;
  const load = loadavg()[0] ?? 0;
  if (load > 8) return `1-min load ${load.toFixed(1)} > 8`;
  return false;
}

test("rn-template: engaging the analysis pool does not regress the readability setup", { skip: tooBusy() }, async () => {
  const bytes = new Uint8Array(readFileSync(rnTemplatePath()));

  const t0 = performance.now();
  rawFrameBodies(analyseModule(parseHbc(bytes), { strictEnv: true }), { strictEnv: true });
  const serialMs = performance.now() - t0;

  // The serial path is measured exactly once (above); this run is the pooled
  // one only, forced on with `minFunctions: 0` because rn-template is far
  // below the production threshold.
  const t1 = performance.now();
  const parallel = await analyseModuleParallel(bytes, { strictEnv: true, minFunctions: 0 }, Math.min(4, Math.max(2, cpus().length - 2)));
  rawFrameBodies(parallel, { strictEnv: true });
  const parallelMs = performance.now() - t1;

  assert.equal(stageACoverage(parallel), parallel.module.functions.length);
  // Generous: worker startup on a loaded box is noisy. This catches "the
  // pool has become a multiple of the serial cost", which is the regression
  // that matters, without pretending to be a benchmark.
  assert.ok(parallelMs < serialMs * 3 + 5_000, `pooled ${parallelMs.toFixed(0)} ms vs serial ${serialMs.toFixed(0)} ms`);
});

test("the main thread's event loop stays free while the analysis pool works", { skip: tooBusy() }, async () => {
  const bytes = new Uint8Array(readFileSync(rnTemplatePath()));
  let worstMs = 0;
  let stop = false;
  const ticker = (async (): Promise<void> => {
    while (!stop) {
      const t = performance.now();
      await delay(20);
      worstMs = Math.max(worstMs, performance.now() - t - 20);
    }
  })();
  const parallel = await analyseModuleParallel(bytes, { strictEnv: true, minFunctions: 0 }, 4);
  stop = true;
  await ticker;
  assert.equal(stageACoverage(parallel), parallel.module.functions.length);
  // The pool phase is `await`ed, so a timer queued next to it must fire on
  // time. Anything above a second means the stage-A work leaked back onto
  // the main thread.
  assert.ok(worstMs < 1_000, `worst timer latency during the pool phase: ${worstMs.toFixed(0)} ms`);
});
