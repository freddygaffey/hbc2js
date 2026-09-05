// ACCEPTANCE (shape half): spec 30 -- docs/specs/passes/30-finally-dedup.md.
// The rung itself is NOT implemented (spec 30 section 5 records why: the IR
// change LADDER 5.1 assumes needs block splitting plus a spec-04 change to
// verify.ts's block accounting, which is past the brief's stop condition).
// What ships here is the ground truth the spec is built on, pinned so that a
// later implementer -- or a change to the parser, the CFG or the structurer --
// cannot quietly invalidate it:
//
//   * section 1: fixture 13's `cleanup` has exactly two copies of the
//     finalizer body, each an instruction RANGE inside a block (never a whole
//     block, never a subtree), equal modulo a consistent register bijection;
//   * section 9: fixture 12's `f1`/`f3` contain no `try` at all at default -O,
//     so "12 prints a single finally" is only reachable for its `f2`.
//
// Rung-owned structural properties only; no whole-output comparison against a
// shared fixture (CLAUDE.md testing rules / CONSOLIDATION section B item 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseForDecompile } from "../../../src/decompile.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { structure, printTree } from "../../../src/structure/index.ts";
import type { FunctionCfg } from "../../../src/cfg/types.ts";
import type { Instruction } from "../../../src/disasm/decode.ts";
import { repoRoot } from "../../support/paths.ts";

const CONSTRUCTS = join(repoRoot(), "tests", "fixtures", "constructs");
const VERSIONS = ["v84", "v94", "v96", "v98", "v99"] as const;

const cfgOf = (fixture: string, version: string, fnIndex: number): FunctionCfg => {
  const bytes = readFileSync(join(CONSTRUCTS, fixture, `${version}.hbc`));
  const { module } = parseForDecompile(bytes, { resolveV98Ambiguity: true });
  return analyseModule(module, { strictEnv: false }).cfg(fnIndex);
};

/** Spec 30 section 1 fact 2: two instruction ranges are copies of one source
 *  statement when their opcodes and non-register operands agree and their
 *  register operands agree under ONE bijection (identity on shared reads). */
function isomorphicModuloRegisters(a: readonly Instruction[], b: readonly Instruction[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const fwd = new Map<number, number>();
  const back = new Map<number, number>();
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.name !== y.name || x.operands.length !== y.operands.length) return false;
    for (let j = 0; j < x.operands.length; j++) {
      const ox = x.operands[j]!;
      const oy = y.operands[j]!;
      if (ox.role !== oy.role || ox.type !== oy.type) return false;
      if (ox.role !== "reg") {
        if (ox.value !== oy.value) return false;
        continue;
      }
      const rx = ox.value;
      const ry = oy.value;
      if ((fwd.get(rx) ?? ry) !== ry || (back.get(ry) ?? rx) !== rx) return false;
      fwd.set(rx, ry);
      back.set(ry, rx);
    }
  }
  return true;
}

for (const version of VERSIONS) {
  test(`spec 30 section 1: 13-try-finally-no-catch cleanup has two range-copies of the finalizer at ${version}`, () => {
    const cfg = cfgOf("13-try-finally-no-catch", version, 2);
    assert.equal(cfg.regions.length, 1, "one exception region");
    const region = cfg.regions[0]!;
    const handler = cfg.blocks[region.handlerBlock]!;
    const ins = handler.instructions;
    // Handler shape: Catch <catchRegister> ... Throw <catchRegister>.
    assert.equal(ins[0]!.name, "Catch");
    assert.equal(ins[ins.length - 1]!.kind, "throw");
    const fromHandler = ins.slice(1, ins.length - 1);
    assert.ok(fromHandler.length > 0, "the handler carries a non-empty finalizer copy");

    // The other copy is a PREFIX of some other block whose terminator is the
    // normal exit -- i.e. a sub-block range, which is the whole reason spec 30
    // rejects a `finalizer: Stmt` subtree (section 3.1).
    const others = cfg.blocks.filter((b) => b !== null && b !== undefined && b.id !== handler.id);
    const found: { block: number; at: number; literal: boolean }[] = [];
    for (const b of others) {
      for (let p = 0; p + fromHandler.length <= b!.instructions.length; p++) {
        const range = b!.instructions.slice(p, p + fromHandler.length);
        if (!isomorphicModuloRegisters(fromHandler, range)) continue;
        found.push({ block: b!.id, at: p, literal: fromHandler.every((x, i) => JSON.stringify(x.operands) === JSON.stringify(range[i]!.operands)) });
      }
    }
    // MEASURED EXCEPTION, v96 (docs/BUGS.md row "finally-dedup v96 copies not
    // opcode-identical", spec 30 section 8): at v96 the handler-side copy and
    // the normal-path copy of the SAME source statement do not agree opcode
    // for opcode, so no register bijection exists and the section-2 matcher
    // would refuse with R-FD1. Pinned, not papered over.
    if (version === "v96") {
      assert.equal(found.length, 0, "v96: the copies are not opcode-identical (R-FD1)");
      return;
    }
    assert.equal(found.length, 1, "exactly one normal-path copy");
    const copy = others.find((b) => b!.id === found[0]!.block)!;
    assert.ok(found[0]!.at + fromHandler.length < copy.instructions.length, "the copy is a strict sub-range of its block, not the whole block");
    assert.equal(copy.instructions[copy.instructions.length - 1]!.kind, "return", "that block's terminator is the normal (returning) exit");
    assert.equal(found[0]!.literal, false, "the copies differ in their scratch registers (LADDER 5.1's `sameCode` would refuse)");
  });

  test(`spec 30 section 1: 13-try-finally-no-catch cleanup structures identically at ${version}`, () => {
    const cfg = cfgOf("13-try-finally-no-catch", version, 2);
    const tree = printTree(structure(cfg, { verify: true }));
    assert.match(tree, /try r\d+ \(head b\d+\) \{\n {2}block b\d+\n {2}return b\d+\n\} catch r\d+ \{\n {2}throw b\d+\n\}/);
  });

  test(`spec 30 section 9: 12-try-catch-finally-return f1 and f3 have no try at ${version}`, () => {
    for (const fnIndex of [1, 3]) {
      const cfg = cfgOf("12-try-catch-finally-return", version, fnIndex);
      assert.equal(cfg.regions.length, 0, `fn#${fnIndex} keeps no exception region at default -O`);
      assert.doesNotMatch(printTree(structure(cfg, { verify: true })), /try /);
    }
    // f2 (case B) is the one site in fixture 12 the rung could ever merge.
    assert.equal(cfgOf("12-try-catch-finally-return", version, 2).regions.length, 2);
  });
}

test("spec 30 section 3.2: the structurer's duplicatedBlocks records none of these copies", () => {
  // LADDER 5.1 proposes measuring the copy count with `duplicatedBlocks`;
  // that field is the structurer's record of its OWN node splitting and is 0
  // at every finalizer site (PUSHBACK P-49 item 1).
  for (const [fixture, fnIndex] of [["13-try-finally-no-catch", 2], ["12-try-catch-finally-return", 2]] as const) {
    for (const version of VERSIONS) {
      const s = structure(cfgOf(fixture, version, fnIndex), { verify: true });
      assert.deepEqual([...s.duplicatedBlocks], [], `${fixture} ${version}`);
    }
  }
});
