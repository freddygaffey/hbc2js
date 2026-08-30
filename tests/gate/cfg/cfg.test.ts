// docs/specs/03-cfg.md §9 — T1 (structure), T2 (byte-anchored), T3 (exception
// invariants corpus-wide), T4 (generators), T5 (environment graph).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { m4Binaries, parseM4 } from "../../support/m4.ts";
import { analyseModule, buildCfg } from "../../../src/cfg/index.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import { Hbc2jsError } from "../../../src/errors.ts";

function fixturePath(group: string, name: string, file: string): string {
  return join(repoRoot(), "tests", "fixtures", group, name, file);
}

function analyse(path: string, opts: Parameters<typeof analyseModule>[1] = {}): ReturnType<typeof analyseModule> {
  const { module } = parseM4(new Uint8Array(readFileSync(path)));
  return analyseModule(module, opts);
}

// ---------------------------------------------------------------------------
// T3 / T5 — corpus-wide: every function of every gate binary builds a CFG with
// all invariants holding, and every (env, slot) resolves statically (R3).
// ---------------------------------------------------------------------------

test("CFG-01..19 hold, and every environment access resolves, for every gate binary", () => {
  const binaries = m4Binaries(["", ".min"]);
  assert.ok(binaries.length > 400, `expected the full gate corpus, got ${binaries.length}`);
  const failures: string[] = [];
  for (const b of binaries) {
    try {
      const a = analyse(b.path, { strictEnv: true });
      for (let i = 0; i < a.module.functions.length; i++) a.cfg(i);
      const g = a.envGraph;
      assert.equal(g.unresolved.length, 0);
      const materialised = g.slots.filter((s) => s.strategy === "materialised");
      if (materialised.length > 0) failures.push(`${b.fixture} v${b.version}${b.variant}: ${materialised.length} materialised slots`);
    } catch (e) {
      failures.push(`${b.fixture} v${b.version}${b.variant}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  assert.deepEqual(failures, []);
});

// ---------------------------------------------------------------------------
// T2 — byte-anchored assertions, not snapshots.
// ---------------------------------------------------------------------------

test("T2: hermes-dec-sample v94 function 5 has three properly nested regions", () => {
  const a = analyse(join(repoRoot(), "tests", "fixtures", "hermes-dec-sample", "v94.hbc"), { strictEnv: false });
  const cfg = a.cfg(5);
  assert.equal(cfg.regions.length, 3);
  const ranges = cfg.regions.map((r) => [r.startPc, r.endPc]);
  assert.deepEqual(new Set(ranges.map((r) => r.join("-"))), new Set(["30-71", "30-50", "75-149"])); // 0x1e-0x47, 0x1e-0x32, 0x4b-0x95
  const handlerOffsets = cfg.regions.map((r) => cfg.blocks[r.handlerBlock]!.start).sort((x, y) => x - y);
  assert.deepEqual(handlerOffsets, [0x34, 0x49, 0x97]);
  for (const r of cfg.regions) assert.equal(cfg.blocks[r.handlerBlock]!.instructions[0]!.name, "Catch");
  // The two regions sharing startPc 0x1e nest: the narrower one's parent is the wider.
  const inner = cfg.regions.find((r) => r.startPc === 0x1e && r.endPc === 0x32)!;
  const outer = cfg.regions.find((r) => r.startPc === 0x1e && r.endPc === 0x47)!;
  assert.equal(inner.parent, outer.index);
});

test("T2: hermes-dec-sample v99 function 5 shares one handler across every region", () => {
  const a = analyse(join(repoRoot(), "tests", "fixtures", "hermes-dec-sample", "v99.hbc"), { strictEnv: false });
  const cfg = a.cfg(5);
  assert.equal(cfg.regions.length, 5);
  const targets = new Set(cfg.regions.map((r) => cfg.blocks[r.handlerBlock]!.start));
  assert.deepEqual([...targets], [0x17b]);
  // Spec 03 §9 T2 predicted "four of them"; the bytes say all five. sharesHandlerWith
  // is therefore a single group of size 5 (each region lists the other four).
  for (const r of cfg.regions) assert.equal(r.sharesHandlerWith.length, 4);
});

test("T2: jump-table switches carry one edge per case plus exactly one default", () => {
  for (const [name, expected] of [
    ["52-switch-jumptable", 14],
    ["53-switch-jumptable-large", 41],
  ] as const) {
    const a = analyse(fixturePath("constructs", name, "v94.hbc"), { strictEnv: false });
    const cfg = a.cfg(1);
    const sw = cfg.blocks.find((b) => b.terminator.kind === "switch");
    assert.ok(sw, `${name}: no switch block`);
    assert.equal(sw.succs.length, expected, name);
    assert.equal(sw.succs.filter((e) => e.kind === "switch-default").length, 1, name);
    assert.equal(sw.succs.filter((e) => e.kind === "switch-case").length, expected - 1, name);
  }
});

// ---------------------------------------------------------------------------
// T4 — generator classification and the §4.5 resume dispatcher.
// ---------------------------------------------------------------------------

test("T4: the two-hop resolution finds the body, never the trampoline", () => {
  for (const [version, tramp, inner] of [
    [84, 1, 2],
    [94, 1, 2],
    [96, 1, 2],
    [98, 1, 3],
    [99, 1, 3],
  ] as const) {
    const a = analyse(fixturePath("constructs", "23-generator-basic", `v${version}.hbc`), { strictEnv: true });
    const outer = a.kinds[1]!;
    assert.equal(outer.kind, "generator", `v${version}`);
    assert.equal(outer.trampolineFunctionIndex, tramp, `v${version} trampoline`);
    assert.equal(outer.innerFunctionIndex, inner, `v${version} inner`);
    assert.equal(a.kinds[inner]!.shimRequired, true, `v${version} shimRequired on the body`);
    // The trap S2 describes: the trampoline itself has zero suspend points.
    assert.equal(a.cfg(tramp).generator.suspendPoints.length, 0, `v${version} trampoline suspend points`);
  }
});

test("T4: v94 23-generator-basic has four suspend points and a resume dispatcher", () => {
  const a = analyse(fixturePath("constructs", "23-generator-basic", "v94.hbc"), { strictEnv: true });
  const cfg = a.cfg(2);
  assert.equal(cfg.generator.info.era, "opcode");
  assert.deepEqual(
    cfg.generator.suspendPoints.map((s) => s.saveOffset),
    [11, 25, 39, 57],
  );
  assert.deepEqual(
    cfg.generator.suspendPoints.map((s) => cfg.blocks[s.resumeBlock]!.start),
    [15, 29, 43, 61],
  );
  assert.ok(cfg.generator.suspendPoints.every((s) => s.canonical));
  assert.notEqual(cfg.generator.resumeDispatch, null);
  assert.equal(cfg.entry, cfg.generator.resumeDispatch);
  const dispatch = cfg.blocks[cfg.entry]!;
  assert.equal(dispatch.start, -1);
  assert.equal(dispatch.terminator.kind, "switch");
  assert.equal(dispatch.succs.filter((e) => e.kind === "switch-case").length, 5); // states 0..4
  for (const s of cfg.generator.suspendPoints) assert.ok(cfg.blocks[s.resumeBlock]!.preds.includes(cfg.entry));
  // The point of the whole exercise (CFG-10): every block has an idom and is reachable.
  for (const b of cfg.blocks) {
    if (b.id === cfg.entry) continue;
    assert.notEqual(cfg.dom.idom[b.id], null, `block ${b.id} at ${b.start} has no idom`);
  }
});

test("T4 negative: disabling §4.5 makes CFG-05 fire as E_INTERNAL", () => {
  assert.throws(
    () => {
      const a = analyse(fixturePath("constructs", "23-generator-basic", "v94.hbc"), { strictEnv: false, disableResumeDispatch: true });
      a.cfg(2);
    },
    (e: unknown) => e instanceof Hbc2jsError && /CFG-0[15]/.test(e.message),
  );
});

test("T4: v98/v99 generator bodies are era 'lowered' with no dispatcher and no unreachable blocks", () => {
  for (const version of [98, 99]) {
    for (const name of ["23-generator-basic", "24-generator-return-throw", "26-infinite-generator-take"]) {
      const a = analyse(fixturePath("constructs", name, `v${version}.hbc`), { strictEnv: true });
      for (let i = 0; i < a.module.functions.length; i++) {
        const cfg = a.cfg(i);
        assert.equal(cfg.generator.suspendPoints.length, 0, `${name} v${version} fn${i}`);
        assert.equal(cfg.generator.resumeDispatch, null, `${name} v${version} fn${i}`);
        const unreachable = cfg.diagnostics.filter((d) => d.code === "W_UNREACHABLE_BLOCK");
        assert.deepEqual(unreachable, [], `${name} v${version} fn${i} unreachable blocks`);
      }
      assert.ok(
        a.kinds.some((k) => k.era === "lowered" && k.shimRequired),
        `${name} v${version}: no shim site`,
      );
    }
  }
});

test("T4: v84/v94/v96 generators and async bodies all have a dispatcher", () => {
  for (const version of [84, 94, 96]) {
    for (const name of ["23-generator-basic", "24-generator-return-throw", "25-generator-delegation", "26-infinite-generator-take", "27-async-await-basic", "28-async-await-error"]) {
      const a = analyse(fixturePath("constructs", name, `v${version}.hbc`), { strictEnv: true });
      let bodies = 0;
      for (let i = 0; i < a.module.functions.length; i++) {
        const cfg = a.cfg(i);
        if (cfg.generator.suspendPoints.length === 0) continue;
        bodies++;
        assert.equal(cfg.generator.info.era, "opcode", `${name} v${version} fn${i}`);
        assert.notEqual(cfg.generator.resumeDispatch, null, `${name} v${version} fn${i}`);
        assert.equal(cfg.entry, cfg.generator.resumeDispatch, `${name} v${version} fn${i}`);
      }
      assert.ok(bodies > 0, `${name} v${version}: no generator body with suspend points`);
    }
  }
});

// ---------------------------------------------------------------------------
// T5 — environment graph
// ---------------------------------------------------------------------------

test("T5: closure fixtures resolve every slot lexically", () => {
  for (const name of ["17-closure-loop-var", "18-closure-loop-let", "21-iife-closures", "22-nested-closures-counters"]) {
    for (const version of [84, 94, 96, 99]) {
      const a = analyse(fixturePath("constructs", name, `v${version}.hbc`), { strictEnv: true });
      const g = a.envGraph;
      assert.equal(g.unresolved.length, 0, `${name} v${version}`);
      assert.ok(g.slots.length > 0, `${name} v${version}: no env slots at all`);
      for (const s of g.slots) assert.equal(s.strategy, "lexical", `${name} v${version} env${s.env}:${s.slot}`);
    }
  }
});

test("T5: StoreNPToEnvironment and StoreToEnvironment address the same slot", () => {
  // 18-closure-loop-let writes the loop variable with StoreNPToEnvironment on
  // init and StoreToEnvironment on the increment (docs/lowering/closures-env-slots.md).
  const a = analyse(fixturePath("constructs", "18-closure-loop-let", "v94.hbc"), { strictEnv: true });
  const fn = a.decoded(0);
  const np = fn.instructions.filter((i) => i.name === "StoreNPToEnvironment");
  const st = fn.instructions.filter((i) => i.name === "StoreToEnvironment");
  assert.ok(np.length > 0 && st.length > 0, "fixture no longer contains both store forms");
  const g = a.envGraph;
  const touched = new Set(g.slots.filter((s) => s.writers.has(0)).map((s) => `${s.env}:${s.slot}`));
  const fromInstructions = new Set(
    [...np, ...st].map((i) => {
      const env = g.resolvedAt.get(`0:${i.offset}`);
      return `${env}:${i.operands[1]!.value}`;
    }),
  );
  for (const k of fromInstructions) assert.ok(touched.has(k), `slot ${k} missing from the graph`);
});

// ---------------------------------------------------------------------------
// Exception edges never enter the normal graph (spec 03 §10 acceptance).
// ---------------------------------------------------------------------------

test("exception edges live only in exceptionSuccs, and including them would change the dominator tree", () => {
  const bytes = new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "hermes-dec-sample", "v94.hbc")));
  const { module } = parseM4(bytes);
  const a = analyseModule(module, { strictEnv: false });
  const cfg = a.cfg(5);
  const handlers = new Set(cfg.regions.map((r) => r.handlerBlock));
  assert.ok(handlers.size > 0);
  assert.ok(cfg.exceptionSuccs.size > 0);

  // Build a comparison CFG whose handler blocks are reachable *only* through the
  // exception edges: with them excluded (as spec 03 requires) those blocks have
  // no idom, which is exactly why the separation is load-bearing.
  const withEdges = buildCfg(decodeFunction(module, 5), { kind: a.kinds[5]!, maxBlocks: 1000, checkInvariants: false, disableResumeDispatch: false });
  let handlerWithoutIdom = 0;
  for (const h of handlers) if (withEdges.dom.idom[h] === null && h !== withEdges.entry) handlerWithoutIdom++;
  assert.ok(handlerWithoutIdom > 0, "no handler block is exception-only-reachable; the test lost its subject");

  for (const b of cfg.blocks) {
    for (const e of b.succs) {
      const via = cfg.exceptionSuccs.get(b.id) ?? [];
      if (via.includes(e.to)) {
        // Legal only when a real instruction also branches there.
        const last = b.instructions[b.instructions.length - 1];
        assert.ok(last !== undefined && last.targets.includes(cfg.blocks[e.to]!.start), `block ${b.id} -> ${e.to} is an exception edge in succs`);
      }
    }
  }
});
