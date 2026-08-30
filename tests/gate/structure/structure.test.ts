// docs/specs/04-structurer.md §8 — T1 (round-trip isomorphism, corpus-wide),
// T3 (targeted shapes), T4 (irreducibility, synthetically), T6 (determinism).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { m4Binaries, parseM4 } from "../../support/m4.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { computeDominators } from "../../../src/cfg/dom.ts";
import type { BasicBlock, BlockId, Edge, FunctionCfg, FunctionKindInfo } from "../../../src/cfg/types.ts";
import { checkIsomorphic, printTree, reconstruct, structure } from "../../../src/structure/index.ts";
import { Hbc2jsError } from "../../../src/errors.ts";

function fixture(name: string, file: string): string {
  return join(repoRoot(), "tests", "fixtures", "constructs", name, file);
}

function analyse(path: string): ReturnType<typeof analyseModule> {
  const { module } = parseM4(new Uint8Array(readFileSync(path)));
  return analyseModule(module, { strictEnv: false });
}

// ---------------------------------------------------------------------------
// T1 — the headline test.
// ---------------------------------------------------------------------------

test("T1: every function of every gate binary structures and round-trips isomorphically", () => {
  const failures: string[] = [];
  let functions = 0;
  let dispatched = 0;
  for (const b of m4Binaries(["", ".min"])) {
    let a: ReturnType<typeof analyseModule>;
    try {
      a = analyse(b.path);
    } catch (e) {
      failures.push(`${b.fixture} v${b.version}${b.variant}: parse/analyse: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (let i = 0; i < a.module.functions.length; i++) {
      try {
        const s = structure(a.cfg(i), { verify: true });
        functions++;
        if (s.stats.dispatchVars > 0) dispatched++;
      } catch (e) {
        failures.push(`${b.fixture} v${b.version}${b.variant} fn${i}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(functions > 1900, `expected ~2000 functions, structured ${functions}`);
  // Recorded, not asserted at zero: `16-finally-with-break-continue` at
  // v84/v94/v96 is genuinely irreducible once exception flow is modelled (see
  // the targeted test below), so `auto` resolves it with a dispatch variable.
  assert.ok(dispatched <= 6, `${dispatched} functions needed dispatch mode; docs/STATUS.md lists the expected six`);
});

// ---------------------------------------------------------------------------
// T3 — targeted baseline shapes. These are the *un-raised* forms; a spec 07 pass
// that changes them should be visible here.
// ---------------------------------------------------------------------------

test("T3: 02-while-loop is a loop containing an if that breaks, not a while(c)", () => {
  const a = analyse(fixture("02-while-loop", "v94.hbc"));
  const text = printTree(structure(a.cfg(0)));
  assert.match(text, /loop \{/);
  assert.match(text, /if b\d+ \{\n\s+break L\d+/);
});

test("T3: 09/10 switch-on-compare-chains produce an if-tree, not an IR switch", () => {
  for (const name of ["09-switch-fallthrough", "10-switch-no-fallthrough"]) {
    const a = analyse(fixture(name, "v94.hbc"));
    for (let i = 0; i < a.module.functions.length; i++) {
      const text = printTree(structure(a.cfg(i)));
      assert.ok(!text.includes("switch b"), `${name} fn${i} produced an IR switch`);
    }
  }
});

test("T3: 52/53 jump tables produce one IR switch with the right arm count", () => {
  for (const [name, arms] of [
    ["52-switch-jumptable", 13],
    ["53-switch-jumptable-large", 40],
  ] as const) {
    const a = analyse(fixture(name, "v94.hbc"));
    const s = structure(a.cfg(1));
    const text = printTree(s);
    assert.match(text, /switch b\d+ \(jumptable\)/, name);
    assert.equal((text.match(/^\s*case /gm) ?? []).length, arms, name);
    assert.match(text, /^\s*default:/m, name);
  }
});

test("T3: the try family nests one try node per region", () => {
  const a = analyse(fixture("12-try-catch-finally-return", "v94.hbc"));
  const text = printTree(structure(a.cfg(2)));
  assert.equal((text.match(/^\s*try r\d+/gm) ?? []).length, 2);
  assert.match(text, /try r0[\s\S]*try r1[\s\S]*catch[\s\S]*catch/);
});

test("T3: 13-try-finally-no-catch keeps the duplicated finally body", () => {
  // The compiler duplicates the finally body into the normal path and into the
  // synthesised catch-and-rethrow handler (PRIOR-ART §6.3). The baseline emits
  // both copies; that is the correct-but-verbose form spec 04 §4.5 rule 2 wants.
  const a = analyse(fixture("13-try-finally-no-catch", "v94.hbc"));
  let found = false;
  for (let i = 0; i < a.module.functions.length; i++) {
    const cfg = a.cfg(i);
    if (cfg.regions.length === 0) continue;
    const text = printTree(structure(cfg));
    assert.match(text, /try r\d+/);
    found = true;
  }
  assert.ok(found, "no function with an exception region");
});

test("T3: v84/v94/v96 generator bodies structure into a top-level state switch", () => {
  for (const version of [84, 94, 96]) {
    const a = analyse(fixture("23-generator-basic", `v${version}.hbc`));
    const cfg = a.cfg(2);
    const s = structure(cfg);
    const text = printTree(s);
    assert.match(text, /switch b\d+ \(generator-state\)/, `v${version}`);
    // 4 suspend points => states 0..4 => 5 arms.
    assert.equal((text.match(/^\s*case /gm) ?? []).length, 5, `v${version}`);
    // Every resume block appears exactly once.
    const rec = reconstruct(s);
    for (const sp of cfg.generator.suspendPoints) {
      assert.equal(rec.blocks.filter((b) => b === sp.resumeBlock).length, 1, `v${version} resume block ${sp.resumeBlock}`);
    }
    assert.ok(!text.includes("SaveGenerator"));
  }
});

test("16-finally-with-break-continue is genuinely irreducible at v84/94/96", () => {
  // Recorded because spec 04 O-5 assumed no fixture was. The `finally` body is
  // duplicated into a catch-and-rethrow handler that flows *back into the loop*,
  // so once the exception edge is modelled the loop has two entries.
  for (const version of [84, 94, 96]) {
    const a = analyse(fixture("16-finally-with-break-continue", `v${version}.hbc`));
    const s = structure(a.cfg(0));
    assert.equal(s.stats.dispatchVars, 1, `v${version}`);
    assert.equal(checkIsomorphic(s, reconstruct(s)).ok, true, `v${version}`);
  }
});

// ---------------------------------------------------------------------------
// T4 — irreducibility, synthetically.
// ---------------------------------------------------------------------------

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

// §4.2's counterexample: entry -> A, entry -> B, A -> B, B -> A.
const COUNTEREXAMPLE = [[1, 2], [2], [1]];
// three-entry irreducible region
const THREE_ENTRY = [
  [1, 2],
  [3, 4],
  [4, 5],
  [4],
  [5],
  [3],
];
// nested irreducible pair
const NESTED = [
  [1, 2],
  [3, 4],
  [4, 3],
  [5, 1],
  [5, 2],
  [],
];

test("T4: the §4.2 counterexample reaches §4.4 and resolves in both modes", () => {
  const cfg = synthCfg(COUNTEREXAMPLE);
  assert.equal(cfg.reducible, false, "the counterexample must actually be irreducible");

  const dispatch = structure(cfg, { irreducible: "dispatch", verify: true });
  assert.equal(dispatch.dispatchVars.length, 1);
  assert.equal(checkIsomorphic(dispatch, reconstruct(dispatch)).ok, true);

  // `auto` with a 1.0 expansion cap must pick dispatch rather than hang.
  const auto = structure(cfg, { irreducible: "auto", maxExpansion: 1.0, verify: true });
  assert.equal(auto.dispatchVars.length, 1);

  // "duplicate" must not hang: it either splits successfully or reports
  // E_TOO_COMPLEX, and never loops forever.
  try {
    const dup = structure(cfg, { irreducible: "duplicate", verify: true });
    assert.equal(checkIsomorphic(dup, reconstruct(dup)).ok, true);
  } catch (e) {
    assert.ok(e instanceof Hbc2jsError && e.code === "E_TOO_COMPLEX", String(e));
  }
});

test("T4: three-entry and nested irreducible regions structure and verify", () => {
  for (const [name, spec] of [
    ["three-entry", THREE_ENTRY],
    ["nested", NESTED],
  ] as const) {
    const cfg = synthCfg(spec);
    for (const mode of ["auto", "dispatch"] as const) {
      const s = structure(cfg, { irreducible: mode, verify: true });
      assert.equal(checkIsomorphic(s, reconstruct(s)).ok, true, `${name} ${mode}`);
    }
  }
});

test("T4: a reducible synthetic graph needs no dispatch variable", () => {
  // entry -> A -> B -> A (a plain loop) plus an exit.
  const cfg = synthCfg([[1], [2, 3], [1], []]);
  assert.equal(cfg.reducible, true);
  const s = structure(cfg, { verify: true });
  assert.deepEqual(s.dispatchVars, []);
  assert.deepEqual(s.duplicatedBlocks, []);
});

// ---------------------------------------------------------------------------
// Negative control: the checker must have teeth.
// ---------------------------------------------------------------------------

test("checkIsomorphic rejects a deliberately broken translation", () => {
  const a = analyse(fixture("02-while-loop", "v94.hbc"));
  const s = structure(a.cfg(0), { verify: true });
  // Drop one `break`: replace the whole tree's first `if` else-branch with an
  // unreachable leaf. The edge it carried must go missing.
  const broken = { ...s, root: dropFirstBreak(s.root) };
  const result = checkIsomorphic(broken, reconstruct(broken));
  assert.equal(result.ok, false);
});

function dropFirstBreak(node: import("../../../src/structure/ir.ts").Stmt): import("../../../src/structure/ir.ts").Stmt {
  let done = false;
  const walk = (n: import("../../../src/structure/ir.ts").Stmt): import("../../../src/structure/ir.ts").Stmt => {
    if (done) return n;
    if (n.k === "break") {
      done = true;
      return { k: "unreachable" };
    }
    switch (n.k) {
      case "seq":
        return { k: "seq", body: n.body.map(walk) };
      case "labeled":
      case "loop":
        return { ...n, body: walk(n.body) };
      case "if":
        return { ...n, then: walk(n.then), else: walk(n.else) };
      case "switch":
        return { ...n, cases: n.cases.map((c) => ({ ...c, body: walk(c.body) })), default: walk(n.default) };
      case "try":
        return { ...n, body: walk(n.body), handler: walk(n.handler) };
      default:
        return n;
    }
  };
  return walk(node);
}

// ---------------------------------------------------------------------------
// T6 — determinism.
// ---------------------------------------------------------------------------

test("T6: structuring twice produces byte-identical trees", () => {
  for (const name of ["01-if-else-chain", "11-nested-loops-mixed", "23-generator-basic", "52-switch-jumptable"]) {
    const a = analyse(fixture(name, "v94.hbc"));
    for (let i = 0; i < a.module.functions.length; i++) {
      const one = printTree(structure(a.cfg(i)));
      const two = printTree(structure(a.cfg(i)));
      assert.equal(one, two, `${name} fn${i}`);
    }
  }
});

test("ST-01: structure() returns for every function of every obfuscated variant", () => {
  const failures: string[] = [];
  let functions = 0;
  for (const b of m4Binaries([".obf"])) {
    const a = analyse(b.path);
    for (let i = 0; i < a.module.functions.length; i++) {
      try {
        structure(a.cfg(i), { verify: true });
        functions++;
      } catch (e) {
        failures.push(`${b.fixture} v${b.version}.obf fn${i}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  assert.deepEqual(failures.slice(0, 10), []);
  assert.ok(functions > 3000, `structured ${functions} obfuscated functions`);
});
