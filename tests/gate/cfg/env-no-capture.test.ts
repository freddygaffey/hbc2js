// docs/BUGS.md 2026-09-04 (`E_UNBOUND_IDENT` hunt on react-navigation-example,
// cause b) — the *undefined* environment operand.
//
// Hermes compiles a function that captures nothing to
//
//     LoadConstUndefined rE
//     CreateClosure      rD, rE, fn
//
// `rE` is not an unknown environment: it is the compiler stating that this
// closure has no environment at all. `src/cfg/env-graph.ts` used to fold
// `LoadConstUndefined` into UNKNOWN, so every such function came out of the
// graph with no `closureEnvOf` entry — an orphan (`W_ORPHAN_FUNCTION`) whose
// own `selfEnv` was unknown too, so its `CreateFunctionEnvironment` had no
// parent and the closures *it* created cascaded into orphans as well. On
// react-navigation-example-0.85.3 that was 4,009 of the 4,187 orphan
// functions (2,254 created at a site whose creator was fine, 1,755 cascading);
// after the fix it is 0.
//
// The shape needs no new fixture: hermesc emits it for any non-capturing
// nested function, and the construct corpus is full of them at v98/v99 (and at
// v96 for the async fixtures). Before the fix `22-nested-closures-counters`
// v99 had 4 functions with no `closureEnvOf` entry and `12-try-catch-finally-
// return` v99 had 3; every one of them is a non-capturing closure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { parseM4 } from "../../support/m4.ts";
import { analyseModule, buildEnvGraph } from "../../../src/cfg/index.ts";
import type { EnvGraph, FunctionCfg } from "../../../src/cfg/types.ts";
import type { DecodedFunction, Instruction, Operand } from "../../../src/disasm/decode.ts";
import type { HbcModule } from "../../../src/parse/types.ts";

function analyse(name: string, version: number): ReturnType<typeof analyseModule> {
  const path = join(repoRoot(), "tests", "fixtures", "constructs", name, `v${version}.hbc`);
  const { module } = parseM4(new Uint8Array(readFileSync(path)));
  return analyseModule(module, { strictEnv: false });
}

function fixtureExists(name: string, version: number): boolean {
  return existsSync(join(repoRoot(), "tests", "fixtures", "constructs", name, `v${version}.hbc`));
}

/** Fixtures that compile at least one non-capturing closure. */
const SHAPE: readonly (readonly [string, number])[] = [
  ["05-for-in-object", 99],
  ["07-for-of-iterable", 99],
  ["09-switch-fallthrough", 99],
  ["12-try-catch-finally-return", 98],
  ["12-try-catch-finally-return", 99],
  ["13-try-finally-no-catch", 99],
  ["14-nested-try-catch", 99],
  ["17-closure-loop-var", 99],
  ["18-closure-loop-let", 99],
  ["19-var-hoisting", 99],
  ["20-let-const-tdz", 99],
  ["22-nested-closures-counters", 98],
  ["22-nested-closures-counters", 99],
  ["100-irreducible-try-retry", 99],
  ["101-irreducible-loop-window", 99],
];

test("T5: a closure created with an undefined environment operand is known to have none, not an orphan", (t) => {
  const available = SHAPE.filter(([n, v]) => fixtureExists(n, v));
  if (available.length === 0) {
    t.skip("no construct fixture .hbc present (INCONCLUSIVE, not a failure)");
    return;
  }
  const offenders: string[] = [];
  let sawNoEnvClosure = false;
  for (const [name, version] of available) {
    const a = analyse(name, version);
    const g = a.envGraph;
    for (let i = 0; i < a.module.functions.length; i++) {
      if (i === a.module.header.globalCodeIndex) continue;
      if (!g.closureEnvOf.has(i)) offenders.push(`${name} v${version} fn#${i}`);
      else if (g.closureEnvOf.get(i) === null) sawNoEnvClosure = true;
    }
    const orphanWarnings = a.diagnostics.filter((d) => d.code === "W_ORPHAN_FUNCTION");
    for (const d of orphanWarnings) offenders.push(`${name} v${version} W_ORPHAN_FUNCTION ${d.message}`);
  }
  assert.deepEqual(offenders, [], "a non-capturing closure is being reported as an orphan again (src/cfg/env-graph.ts, the `none` lattice value for LoadConstUndefined)");
  assert.ok(sawNoEnvClosure, "no fixture in this list produced a closure with a known-empty environment; the SHAPE list no longer exercises the rule");
});

test("T5: the undefined-env shape is really present in the corpus this test relies on", () => {
  // Guards the test above against passing vacuously if hermesc ever stops
  // emitting `LoadConstUndefined` into the environment operand.
  const a = analyse("22-nested-closures-counters", 99);
  let sites = 0;
  for (let f = 0; f < a.module.functions.length; f++) {
    const ins = a.decoded(f).instructions;
    for (let k = 1; k < ins.length; k++) {
      if (!/^Create(Async|Generator)?Closure/.test(ins[k]!.name)) continue;
      const envReg = ins[k]!.operands[1]!.value;
      for (let j = k - 1; j >= 0 && j > k - 6; j--) {
        if (ins[j]!.name === "LoadConstUndefined" && ins[j]!.operands[0]!.value === envReg) {
          sites++;
          break;
        }
      }
    }
  }
  assert.ok(sites > 0, "22-nested-closures-counters v99 no longer contains `LoadConstUndefined rE; CreateClosure rD, rE, fn`");
});

test("T5: an environment operand that is a real env on one path and undefined on another stays ambiguous", () => {
  // Soundness half of the rule: `none` must never win over a real environment.
  // Synthesised, because no fixture produces it — a well-formed Hermes output
  // cannot, which is exactly why it must not be resolved silently if one ever
  // does. Built directly on `buildEnvGraph` with a two-branch function whose
  // join feeds a single `CreateClosure`.
  const { graph } = twoSiteModule();
  const conflict = graph.diagnostics.filter((d) => d.code === "W_AMBIGUOUS_CLOSURE_ENV");
  assert.deepEqual(
    conflict.map((d) => (d.context as { functionIndex?: number }).functionIndex),
    [2],
    "fn#2 is created once with env 0 and once with an undefined environment operand; it must be reported ambiguous, not bound to env 0",
  );
  assert.equal(graph.closureEnvOf.get(2), null, "an ambiguous function must not keep a resolved environment");
  assert.ok(graph.closureEnvOf.has(1), "fn#1 is created only with an undefined environment operand: that is a known environment (none), not a missing entry");
  assert.equal(graph.closureEnvOf.get(1), null, "fn#1 captures nothing");
});

test("T6: every Create*Closure site is recorded, with the environment it captured", () => {
  // The evidence an ambiguity fix needs: `W_AMBIGUOUS_CLOSURE_ENV` says only
  // *that* a function was created with two environments, and `closureEnvOf`
  // then reports `null`, so nothing downstream can tell how many sites there
  // were, where they are, or which environment each one captured. Per-creation-
  // context body duplication (docs/reports/2026-09-05-ambiguous-closure-env.md)
  // is driven entirely off this map, and so is the bucketing that measured the
  // 178 ambiguous functions on react-navigation-example-0.85.3.
  const { graph } = twoSiteModule();
  const sites2 = graph.closureCreationSites.get(2);
  assert.ok(sites2 !== undefined, "fn#2 has two Create*Closure sites; none were recorded");
  assert.deepEqual(
    [...sites2].sort(([a], [b]) => (a < b ? -1 : 1)),
    [
      ["0:4", 0],
      ["0:12", null],
    ].sort(([a], [b]) => ((a as string) < (b as string) ? -1 : 1)),
    "fn#2 is created at offset 4 over env 0 and at offset 12 over the undefined environment operand",
  );
  assert.equal(new Set(sites2.values()).size, 2, "the two sites disagree: that disagreement is exactly what makes fn#2 ambiguous");
  assert.deepEqual([...graph.closureCreationSites.get(1)!.values()], [null], "fn#1 has a single site and it captures nothing");
  for (const [f, sites] of graph.closureCreationSites) {
    for (const key of sites.keys()) assert.match(key, /^\d+:\d+$/, `creation site key ${key} of fn#${f} is not siteKey(function, offset)`);
  }
});

// --- synthesis -------------------------------------------------------------

type Op = { readonly name: string; readonly ops: readonly (readonly [string, number])[] };

function instructions(ops: readonly Op[]): Instruction[] {
  return ops.map((o, i) => ({
    offset: i * 4,
    length: 4,
    opcode: 0,
    name: o.name,
    operands: o.ops.map(([role, value]) => ({ type: "Reg8", role, value }) as unknown as Operand),
    kind: o.name === "Ret" ? ("return" as const) : ("normal" as const),
    targets: [] as readonly number[],
    fallsThrough: o.name !== "Ret",
  }));
}

function fakeFunction(index: number, ops: readonly Op[]): DecodedFunction {
  const insns = instructions(ops);
  return {
    index,
    header: { environmentSize: 1 },
    name: `fn${index}`,
    instructions: insns,
    byOffset: new Map(insns.map((x, i) => [x.offset, i])),
    labels: new Map(),
    handlers: [],
    switchTables: [],
  } as unknown as DecodedFunction;
}

function fakeCfg(index: number, fn: DecodedFunction): FunctionCfg {
  const end = fn.instructions.length * 4;
  return {
    functionIndex: index,
    blocks: [{ id: 0, start: 0, end, instructions: fn.instructions, succs: [], preds: [], isHandlerEntry: false }],
    entry: 0,
    exits: [0],
    byOffset: new Map([[0, 0]]),
    exceptionSuccs: new Map(),
    regions: [],
    switchTables: [],
    rpo: [0],
    reducible: true,
    generator: { kind: "none", suspendPoints: [] },
    frameSize: 8,
    paramCount: 0,
    diagnostics: [],
  } as unknown as FunctionCfg;
}

/**
 * fn#0 (global) creates fn#2 twice — once with a real environment, once with an
 * undefined operand — and fn#1 only with an undefined operand.
 */
function twoSiteModule(): { graph: EnvGraph } {
  const fns = new Map<number, DecodedFunction>([
    [
      0,
      fakeFunction(0, [
        { name: "CreateEnvironment", ops: [["reg", 0]] },
        { name: "CreateClosure", ops: [["reg", 1], ["reg", 0], ["function", 2]] },
        { name: "LoadConstUndefined", ops: [["reg", 2]] },
        { name: "CreateClosure", ops: [["reg", 3], ["reg", 2], ["function", 2]] },
        { name: "CreateClosure", ops: [["reg", 4], ["reg", 2], ["function", 1]] },
        { name: "Ret", ops: [["reg", 1]] },
      ]),
    ],
    [1, fakeFunction(1, [{ name: "Ret", ops: [["reg", 0]] }])],
    [2, fakeFunction(2, [{ name: "Ret", ops: [["reg", 0]] }])],
  ]);
  const cfgs = new Map<number, FunctionCfg>([...fns].map(([i, f]) => [i, fakeCfg(i, f)]));
  const graph = buildEnvGraph({
    module: { header: { globalCodeIndex: 0 } } as unknown as HbcModule,
    decode: (i) => fns.get(i)!,
    cfg: (i) => cfgs.get(i)!,
    functionIndices: [0, 1, 2],
  });
  return { graph };
}
