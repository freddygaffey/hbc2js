// docs/BUGS.md 2026-09-05 "Residual `diff:LoadFromEnvironment(imm)` bucket"
// (E2E tier 1, react-navigation-example-0.85.3 v98, passes-on) -- the
// SIBLING-ENVIRONMENT half of that row.
//
// `hermesc -O` inlines an IIFE into its caller but keeps the callee's own
// environment, so a caller that inlines several of them ends up with several
// environments SIDE BY SIDE. react-navigation-example module 681 / fn#683 is
// the real case: `CreateFunctionEnvironment r4, 11` plus twelve more
// `CreateEnvironment`/`CreateFunctionEnvironment` siblings in one function.
//
// Our emitter declares every environment a function owns as one flat
// `let _e<env>_<slot>` list in that function's top scope. Recompiling that
// source gives hermesc a single scope, and it allocates a SINGLE environment
// with the slots renumbered end to end -- which is the
// `diff:CreateFunctionEnvironment(imm)` / `diff:LoadFromEnvironment(imm)`
// verdict on the corpus.
//
// The rung-owned property asserted here (no whole-output comparison on a
// shared fixture, CLAUDE.md testing rules): decompiling fixture
// 75-sibling-envs and recompiling the result with the same hermesc must
// reproduce (a) the sizes of the environments created inside the owning
// function, and (b) the slot immediates every reader closure loads.
//
// Only v98/v99 are in scope. v84/v94/v96 do not inline these IIFEs at all
// (the callee stays a separate function with its own environment), so there
// are no sibling environments to flatten there; the corpus measurement this
// row tracks is v98 as well.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoRoot } from "../../support/paths.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import { requireOracles } from "../../support/tiers.ts";
import { decompile } from "../../../src/decompile.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";

const VERSIONS = [98, 99] as const;
type Version = (typeof VERSIONS)[number];

const FIXTURE = join(repoRoot(), "tests", "fixtures", "constructs", "75-sibling-envs");

function fixtureBytes(version: Version): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE, `v${version}.hbc`)));
}

function parse(bytes: Uint8Array) {
  try {
    return parseHbc(bytes);
  } catch {
    return parseHbc(bytes, { opcodeTable: "hbc98-late" });
  }
}

function decompiled(bytes: Uint8Array): string {
  try {
    return decompile(bytes).code;
  } catch {
    return decompile(bytes, { opcodeTable: "hbc98-late" }).code;
  }
}

/** Sizes of the environments created inside whichever function creates more
 *  than one, sorted -- the fixture has exactly one such function. */
function siblingEnvSizes(bytes: Uint8Array): number[] {
  const mod = parse(bytes);
  let found: number[] = [];
  for (let i = 0; i < mod.functions.length; i++) {
    const creates = decodeFunction(mod, i).instructions.filter((insn) => insn.name === "CreateFunctionEnvironment");
    if (creates.length <= 1) continue;
    assert.equal(found.length, 0, "fixture 75 should have exactly one function creating sibling environments");
    found = creates.map((insn) => insn.operands[1]!.value).sort((a, b) => a - b);
  }
  return found;
}

/** For every "reader" closure -- a function whose only environment traffic is
 *  reads -- the sorted slot immediates it loads. Sorted as a whole, because
 *  the readers are interchangeable and their table order is not this test's
 *  property. */
function readerSlots(bytes: Uint8Array): string[] {
  const mod = parse(bytes);
  const out: string[] = [];
  for (let i = 0; i < mod.functions.length; i++) {
    const env = decodeFunction(mod, i).instructions.filter((insn) => /Environment/.test(insn.name));
    if (env.length === 0) continue;
    if (!env.every((insn) => insn.name === "GetParentEnvironment" || insn.name.startsWith("LoadFromEnvironment"))) continue;
    const slots = env.filter((insn) => insn.name.startsWith("LoadFromEnvironment")).map((insn) => insn.operands[2]!.value);
    if (slots.length === 0) continue;
    out.push(slots.sort((a, b) => a - b).join(","));
  }
  return out.sort();
}

function recompile(version: Version, source: string): Uint8Array {
  const hermesc = findHermesc(version)!;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-sibling-envs-"));
  try {
    const src = join(dir, "sibling.js");
    writeFileSync(src, source);
    const out = join(dir, "out.hbc");
    const r = runHermesc(hermesc, ["-O", "-emit-binary", `-out=${out}`, "sibling.js"], dir);
    assert.equal(r.status, 0, `hermesc v${version} failed: ${r.stderr}`);
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const version of VERSIONS) {
  test(`75-sibling-envs v${version}: the fixture really does build sibling environments`, () => {
    if (!existsSync(join(FIXTURE, `v${version}.hbc`))) return;
    const sizes = siblingEnvSizes(fixtureBytes(version));
    assert.deepEqual(
      sizes,
      [1, 2, 3],
      `v${version}: the fixture no longer compiles to three sibling environments of 1/2/3 slots — fixture shape changed under this test`,
    );
  });

  // Skipped until the inlined-IIFE reconstruction lands (docs/PUSHBACK.md P-41,
  // ruled default-on 2026-09-05). The body is intact and already asserts the
  // right thing: the fix task makes these green by deleting the skip option.
  test(`75-sibling-envs v${version}: recompiling the decompiled source keeps the sibling environments`, { skip: "BUGS.md: residual diff:LoadFromEnvironment(imm) row, PUSHBACK P-41 -- inlined-IIFE reconstruction not implemented yet" }, (t) => {
    if (!existsSync(join(FIXTURE, `v${version}.hbc`))) return;
    if (findHermesc(version) === null) {
      if (requireOracles()) throw new Error(`hermesc v${version} required (HBC2JS_REQUIRE_ORACLES=1)`);
      t.skip(`hermesc v${version} not found (run tools/get-hermesc.sh ${version})`);
      return;
    }
    const original = fixtureBytes(version);
    const round = recompile(version, decompiled(original));
    assert.deepEqual(
      siblingEnvSizes(round),
      siblingEnvSizes(original),
      `v${version}: the decompiled source recompiles the function's sibling environments into a different set of environments`,
    );
    assert.deepEqual(
      readerSlots(round),
      readerSlots(original),
      `v${version}: the decompiled source recompiles its closures against different environment slot immediates than the original`,
    );
  });
}
