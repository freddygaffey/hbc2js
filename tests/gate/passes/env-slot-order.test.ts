// docs/BUGS.md 2026-09-01 "captured-variable declaration order" row
// (E2E tier 1 buckets `diff:LoadFromEnvironment(imm)` / `diff:CreateFunctionEnvironment(imm)`,
// react-navigation v98). Acceptance-shaped regression guard on a construct
// fixture: decompile 22-nested-closures-counters at every compiled version,
// recompile the decompiled source with the SAME hermesc version (`-O`, the
// mode production bundles and the E2E tier-1 harness both use — `-O0`
// promotes far more locals into the environment than `-O` does and is not
// representative), and for every named function the fixture's own source
// gives a stable identifier (`makeCounter`, `step`, `makeAccumulatorFactory`,
// `makeAccumulator`, `accumulate`), assert the recompiled function's
// `CreateEnvironment`/`CreateFunctionEnvironment` size and the sequence of
// `LoadFromEnvironment`/`StoreToEnvironment` slot immediates match the
// original's exactly (register NAMES differ across a decompile/recompile
// round trip and are deliberately not asserted here — only the environment
// shape is a rung-owned, structural property; no whole-output string compare
// on this shared fixture, CLAUDE.md testing rules). Matching by the
// function's OWN name rather than by table position or count, because the
// decompiled module's wrapper/bookkeeping functions (the module IIFE,
// `globalThis` own-property guards) recompile to a different function COUNT
// than the fixture's raw build without being a regression in this row.
//
// This fixture's own closures each capture exactly one slot per environment,
// so it cannot exercise a same-environment MULTI-slot reordering by itself;
// it still pins the invariant this row cares about (env size + slot layout
// survive the decompile/recompile round trip) and guards the common case
// from regressing. The real, currently-open repro for the multi-slot case (a
// hoisted nested closure whose own body reads slot N before slot M while the
// owning function's post-increment/GetByVal lowering evaluates the array
// base and the index) is documented in the BUGS.md row itself, reproduced
// directly on rn-template-0.72 v94 module 14 fn#224 (`_e46_1` read before
// `_e46_0` inside a hoisted nested closure) — not yet fixed; see that row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoRoot } from "../../support/paths.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import { requireOracles } from "../../support/tiers.ts";
import { decompile } from "../../../src/decompile.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";

const VERSIONS = [84, 94, 96, 98, 99] as const;
type Version = (typeof VERSIONS)[number];

const NAMED_CLOSURES = ["makeCounter", "step", "makeAccumulatorFactory", "makeAccumulator", "accumulate"];

function loadFixture(version: Version): Uint8Array {
  return new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", "22-nested-closures-counters", `v${version}.hbc`)));
}

function recompile(version: Version, source: string): Uint8Array {
  const hermesc = findHermesc(version)!;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-env-slot-order-"));
  try {
    const src = join(dir, "candidate.js");
    writeFileSync(src, source);
    const out = join(dir, "out.hbc");
    const r = runHermesc(hermesc, ["-O", "-emit-binary", `-out=${out}`, "candidate.js"], dir);
    assert.equal(r.status, 0, `hermesc v${version} failed: ${r.stderr}`);
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** name -> { envSize, slotSequence } for every function whose own name is in
 *  `NAMED_CLOSURES` and that creates its own environment (owns captured
 *  vars). `slotSequence` is the `[opcode, slot]` pairs for every
 *  `Load/StoreToEnvironment`-family instruction touching THIS function's own
 *  freshly-created environment register, in program order — register names
 *  are deliberately not part of the key. */
function envShapesByName(bytes: Uint8Array): Map<string, { readonly envSize: number; readonly slots: readonly string[] }> {
  // v98 is sometimes structurally ambiguous between hbc98-late and a v99
  // table (docs/BUGS.md / tests/support/m4.ts) — hbc98-late is the table
  // every known-ambiguous fixture resolves to; irrelevant to this test's own
  // assertion (env slot layout), just needed to parse at all.
  let mod;
  try {
    mod = parseHbc(bytes);
  } catch (e) {
    mod = parseHbc(bytes, { opcodeTable: "hbc98-late" });
  }
  const out = new Map<string, { readonly envSize: number; readonly slots: readonly string[] }>();
  for (let i = 0; i < mod.functions.length; i++) {
    const header = mod.functions[i]!;
    if (!NAMED_CLOSURES.includes(header.name)) continue;
    const fn = decodeFunction(mod, i);
    const createIdx = fn.instructions.findIndex((insn) => insn.name === "CreateEnvironment" || insn.name === "CreateFunctionEnvironment" || insn.name === "CreateTopLevelEnvironment");
    if (createIdx < 0) continue;
    const create = fn.instructions[createIdx]!;
    const envReg = create.operands[0]!.value;
    const envSize = create.name === "CreateEnvironment" && create.operands.length === 1 ? (header.header.environmentSize ?? 0) : create.operands[create.operands.length - 1]!.value;
    const slots: string[] = [];
    for (const insn of fn.instructions) {
      if (!/^(Load|Store|StoreNP)FromEnvironment$|^(Load|Store|StoreNP)ToEnvironment$/.test(insn.name)) continue;
      // Load*: [dest, env, slot]; Store*/StoreNP*: [env, slot, value] — the
      // env operand is always operand 0 for stores, operand 1 for loads.
      const isLoad = insn.name.startsWith("Load");
      const envOperand = isLoad ? insn.operands[1]!.value : insn.operands[0]!.value;
      if (envOperand !== envReg) continue;
      const slot = isLoad ? insn.operands[2]!.value : insn.operands[1]!.value;
      slots.push(`${insn.name}:${slot}`);
    }
    // A name can be reused (the fixture's own bytecode has one `makeCounter`,
    // one `step`, etc., but be defensive): keep the first environment-owning
    // occurrence only, matching how a stable-name lookup would resolve it.
    if (!out.has(header.name)) out.set(header.name, { envSize, slots });
  }
  return out;
}

for (const version of VERSIONS) {
  test(`22-nested-closures-counters v${version}: recompiled environment size + slot sequence matches the original, per named closure (env-slot-order row)`, (t) => {
    if (findHermesc(version) === null) {
      if (requireOracles()) throw new Error(`hermesc v${version} required (HBC2JS_REQUIRE_ORACLES=1)`);
      t.skip(`hermesc v${version} not found (run tools/get-hermesc.sh ${version})`);
      return;
    }
    const original = loadFixture(version);
    const decompiled = decompile(original, { moduleName: "x", resolveV98Ambiguity: true }).code;
    const recompiled = recompile(version, decompiled);
    const before = envShapesByName(original);
    const after = envShapesByName(recompiled);
    let checked = 0;
    for (const name of NAMED_CLOSURES) {
      const b = before.get(name);
      const a = after.get(name);
      if (b === undefined) continue; // this closure didn't own an env at this version's build shape
      assert.ok(a !== undefined, `v${version}: ${name} owned an environment originally but not after decompile+recompile`);
      assert.equal(a.envSize, b.envSize, `v${version}: ${name}'s environment size changed (${b.envSize} -> ${a.envSize})`);
      assert.deepEqual(a.slots, b.slots, `v${version}: ${name}'s Load/StoreToEnvironment slot sequence changed`);
      checked++;
    }
    assert.ok(checked > 0, `v${version}: no named closure in the fixture owned an environment — fixture shape changed under this test`);
  });
}
