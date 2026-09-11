// docs/perf/PARALLEL-DECOMPILE.md -- part 2. Hard correctness gate for
// `analyseModuleParallel`: the readability layer's whole-bundle setup, run
// through the worker pool, must produce the SAME analysis and the SAME raw
// frames as the serial path. Speed without parity is a failure (spec 28
// section 9.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { listFixtures, rnTemplatePath } from "../../support/fixtures.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { rawFrameBodies } from "../../../src/name-overlay/frames.ts";
import { analyseModuleParallel, stageACoverage } from "../../../src/parallel/analysis-pool.ts";
import type { ModuleAnalysis } from "../../../src/cfg/types.ts";

/** Deterministic stringify for comparing two independently built analyses.
 *  Handles what `JSON.stringify` cannot: `bigint` (BigInt literals in a
 *  fixture's AST) and `Map`/`Set` (`byOffset`, `labels`, the env graph's
 *  tables). Function-valued fields (`FunctionCfg.dom.dominates` and friends)
 *  are dropped by `JSON.stringify` itself -- they are derived helpers over
 *  the data that IS compared, and two independently built analyses can never
 *  be reference-equal on them, which is why `deepStrictEqual` cannot be used
 *  on a whole `FunctionCfg`. */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (typeof val === "bigint") return `${val.toString()}n`;
    if (val instanceof Map) return { __map: [...val.entries()] };
    if (val instanceof Set) return { __set: [...val.values()] };
    return val;
  });
}

function framesJson(a: ModuleAnalysis, strictEnv: boolean): string {
  const frames = rawFrameBodies(a, { strictEnv });
  return stable([...frames.entries()].sort((x, y) => x[0] - y[0]));
}

/** Every accessor of `ModuleAnalysis`, fully forced, in index order. */
function forceAll(a: ModuleAnalysis): { readonly decoded: unknown[]; readonly cfgs: unknown[]; readonly kinds: unknown; readonly options: unknown } {
  const decoded: unknown[] = [];
  const cfgs: unknown[] = [];
  for (let i = 0; i < a.module.functions.length; i++) {
    decoded.push(a.decoded(i));
    cfgs.push(a.cfg(i));
  }
  return { decoded, cfgs, kinds: a.kinds, options: a.options };
}

const V = 94;

test("analyseModuleParallel(workers=1) takes the exact serial path -- no Worker spawned", async () => {
  const bytes = new Uint8Array(readFileSync(listFixtures({ version: V })[0]!.binaries[0]!.path));
  const a = await analyseModuleParallel(bytes, { strictEnv: true, minFunctions: 0 }, 1);
  assert.equal(stageACoverage(a), null);
  assert.equal(framesJson(a, true), framesJson(analyseModule(parseHbc(bytes), { strictEnv: true }), true));
});

test("HBC2JS_WORKERS=1 takes the exact serial path -- no Worker spawned", async () => {
  const bytes = new Uint8Array(readFileSync(listFixtures({ version: V })[0]!.binaries[0]!.path));
  const prev = process.env.HBC2JS_WORKERS;
  try {
    process.env.HBC2JS_WORKERS = "1";
    assert.equal(stageACoverage(await analyseModuleParallel(bytes, { strictEnv: true, minFunctions: 0 })), null);
  } finally {
    if (prev === undefined) delete process.env.HBC2JS_WORKERS;
    else process.env.HBC2JS_WORKERS = prev;
  }
});

test("a module below the function-count threshold takes the exact serial path", async () => {
  const bytes = new Uint8Array(readFileSync(listFixtures({ version: V })[0]!.binaries[0]!.path));
  const a = await analyseModuleParallel(bytes, { strictEnv: true }, 4);
  assert.equal(stageACoverage(a), null);
});

test("a worker-side failure rejects loudly, never a partial analysis", async () => {
  const bytes = new Uint8Array(readFileSync(listFixtures({ version: V })[0]!.binaries[0]!.path));
  await assert.rejects(() => analyseModuleParallel(bytes, { strictEnv: true, minFunctions: 0, analysis: { maxBlocks: -1 } }, 2));
});

// Construct-fixture sweep. `minFunctions: 0` forces the pool on modules far
// below the production threshold, which is the point: the splice has to be
// exact for every lowering shape in the catalogue, not just for big bundles.
test("construct fixtures: parallel raw frames are byte-identical to serial", async () => {
  const fixtures = listFixtures({ version: V }).filter((f) => f.group === "constructs");
  assert.ok(fixtures.length > 20, `expected the construct set, got ${fixtures.length}`);
  let checked = 0;
  for (const f of fixtures) {
    const bin = f.binaries.find((b) => b.variant === "");
    if (bin === undefined) continue;
    const bytes = new Uint8Array(readFileSync(bin.path));
    const serial = analyseModule(parseHbc(bytes), { strictEnv: true });
    const parallel = await analyseModuleParallel(bytes, { strictEnv: true, minFunctions: 0 }, 2);
    assert.equal(stageACoverage(parallel), serial.module.functions.length, `${f.name}: pool coverage`);
    assert.equal(framesJson(parallel, true), framesJson(serial, true), `${f.name}: raw frames differ`);
    checked++;
  }
  assert.ok(checked > 20, `expected >20 fixtures checked, got ${checked}`);
});

// The hard gate: rn-template (~4.2k functions), the same bundle
// `tests/gate/decompile/parallel.test.ts` uses for part 1's byte-identity.
test("HARD GATE: rn-template analysis and raw frames, workers=4 vs serial", async () => {
  const bytes = new Uint8Array(readFileSync(rnTemplatePath()));
  const serial = analyseModule(parseHbc(bytes), { strictEnv: true });
  // `minFunctions: 0` forces the pool: rn-template (4,199 fns) is below the
  // production threshold, and this gate is about identity, not about size.
  const parallel = await analyseModuleParallel(bytes, { strictEnv: true, minFunctions: 0 }, 4);
  assert.equal(stageACoverage(parallel), serial.module.functions.length);

  // Every accessor, fully forced, equal and in the same order.
  assert.equal(stable(forceAll(parallel)), stable(forceAll(serial)));
  assert.equal(stable(parallel.envGraph), stable(serial.envGraph));
  // Diagnostics, in order, AFTER the env graph has been forced on both.
  assert.deepEqual([...parallel.diagnostics], [...serial.diagnostics]);

  // The load-bearing one: what NameService / listNameable / runNamePass read.
  const s = framesJson(serial, true);
  const p = framesJson(parallel, true);
  assert.equal(p.length, s.length);
  assert.equal(p, s);
});
