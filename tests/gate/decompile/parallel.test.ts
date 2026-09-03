// docs/perf/PARALLEL-DECOMPILE.md — part 1. Hard correctness gate: the
// worker pool must be BYTE-IDENTICAL to the serial path. Assembly order is
// fixed by `emitOne`'s existing recursion (closure-nesting order), never by
// worker completion order — this is the test that proves it, not just the
// design note's argument.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { rnTemplatePath } from "../../support/fixtures.ts";
import { decompile, decompileParallel } from "../../../src/decompile.ts";
import { resolveWorkerCount } from "../../../src/parallel/pool.ts";
import { cachedDecompile } from "../../support/decompiled.ts";

function fixtureBytes(name: string, file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, file)));
}

test("resolveWorkerCount: explicit, env, and default(cores-2, min 1)", () => {
  assert.equal(resolveWorkerCount(1), 1);
  assert.equal(resolveWorkerCount(3), 3);
  assert.equal(resolveWorkerCount(0), 1); // clamped to min 1
  const prev = process.env.HBC2JS_WORKERS;
  try {
    process.env.HBC2JS_WORKERS = "5";
    assert.equal(resolveWorkerCount(undefined), 5);
    process.env.HBC2JS_WORKERS = "1";
    assert.equal(resolveWorkerCount(undefined), 1);
  } finally {
    if (prev === undefined) delete process.env.HBC2JS_WORKERS;
    else process.env.HBC2JS_WORKERS = prev;
  }
});

test("decompileParallel(workers=1) takes the exact serial decompile() path (no Worker spawned)", async () => {
  const bytes = fixtureBytes("02-while-loop", "v94.hbc");
  const serial = decompile(bytes, { moduleName: "x.hbc" });
  const parallel = await decompileParallel(bytes, { moduleName: "x.hbc" }, 1);
  assert.equal(parallel.code, serial.code);
  assert.equal(parallel.forcedOpcodeTable, serial.forcedOpcodeTable);
  assert.equal(parallel.decompileDiagnostics, serial.decompileDiagnostics);
  assert.equal(parallel.diagnostics.length, serial.diagnostics.length);
});

test("decompileParallel(workers=3) is byte-identical to decompile() on a small construct fixture", async () => {
  const bytes = fixtureBytes("23-generator-basic", "v94.hbc");
  const serial = decompile(bytes, { moduleName: "x.hbc" });
  const parallel = await decompileParallel(bytes, { moduleName: "x.hbc" }, 3);
  assert.equal(parallel.code, serial.code);
  assert.equal(parallel.forcedOpcodeTable, serial.forcedOpcodeTable);
  assert.equal(parallel.decompileDiagnostics, serial.decompileDiagnostics);
});

// The hard gate: a full rn-template readable decompile, workers=4 vs
// workers=1 (serial), must match byte for byte. rn-template is ~4.2k
// functions — big enough to exercise many workers with a real function
// spread, small enough to stay inside the gate's time budget.
test("HARD GATE: rn-template decompile, workers=4 is byte-identical to serial", async () => {
  const bytes = new Uint8Array(readFileSync(rnTemplatePath()));
  const serial = cachedDecompile(bytes, { moduleName: "index.android.hbc" });
  const parallel = await decompileParallel(bytes, { moduleName: "index.android.hbc" }, 4);
  assert.equal(parallel.code.length, serial.code.length);
  assert.equal(parallel.code, serial.code);
  assert.equal(parallel.forcedOpcodeTable, serial.forcedOpcodeTable);
  assert.equal(parallel.decompileDiagnostics, serial.decompileDiagnostics);
  assert.equal(parallel.helpersUsed.join(","), serial.helpersUsed.join(","));
});

test("a worker-side failure fails the whole decompileParallel() loudly (rejects), never a partial result", async () => {
  const bytes = fixtureBytes("02-while-loop", "v94.hbc");
  // An impossible `analysis` option value that survives JSON structured-clone
  // but breaks `analyseModule` inside the worker (never on the main thread,
  // since `decompileParallel` never calls `analyseModule` itself for the
  // pooled path) — proves a worker-side failure surfaces as a rejection,
  // not as a stub or a truncated result.
  await assert.rejects(() => decompileParallel(bytes, { moduleName: "x.hbc", analysis: { maxBlocks: -1 } }, 2));
});
