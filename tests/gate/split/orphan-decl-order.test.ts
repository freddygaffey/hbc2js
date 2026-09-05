// docs/BUGS.md 2026-09-05 "Residual `diff:LoadFromEnvironment(imm)` bucket"
// (E2E tier 1, react-navigation-example-0.85.3 v98, passes-on).
//
// A function that captures nothing and is created from more than one function
// has no single home (src/emit/index.ts F24-5), so it stays an orphan and is
// emitted at module level. `--split` writes one file per Metro factory, and a
// module file that names such an orphan has to carry its declaration, so
// src/split/index.ts pulls it into the factory body.
//
// It used to PREPEND it. Hermes allocates a scope's environment slots in
// textual declaration order (hoisting moves the closure creation, not the
// slot), so every declaration pulled in ahead of the factory's own
// `let _e<env>_<slot>` prologue pushed all of the factory's own slots up by
// one. On react-navigation-example module 681 / fn#683 -- a lazy re-export
// barrel with eleven getters -- two orphans (`_fn13951`, `_fn13952`) gave
// every getter a uniform +2 slot immediate on recompile: 768 clean functions
// round-tripped with the same opcode and the same environment register but a
// different slot immediate.
//
// The rung-owned property asserted here (no whole-output comparison on a
// shared fixture, CLAUDE.md testing rules):
//
//   1. structural, no oracle needed -- the factory's env-slot `let` prologue
//      is emitted before any nested `function _fn...` declaration; and
//   2. with hermesc -- recompiling the split module file reproduces the
//      ORIGINAL bytecode's getter slot immediates exactly.
//
// Fixture 74-sibling-env-slots has the same shape as module 681: five
// captured exports read back through five getters, and two non-capturing
// predicates whose identical bodies hermesc shares between creation sites in
// two different nested functions (which is what makes them orphans).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoRoot } from "../../support/paths.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import { requireOracles } from "../../support/tiers.ts";
import { splitProject } from "../../../src/split/index.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";

// v84/v94 build this barrel with a different environment shape (the getters
// do not all read one shared environment there); the row is about the
// production versions, which is also where the corpus measurement lives.
const VERSIONS = [96, 98, 99] as const;
type Version = (typeof VERSIONS)[number];

const FIXTURE = join(repoRoot(), "tests", "fixtures", "constructs", "74-sibling-env-slots");

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

/** The split file for the fixture's single Metro module. */
function moduleFile(bytes: Uint8Array): string {
  const r = splitProject(bytes, { moduleName: "74-sibling-env-slots.hbc", passes: {} });
  const m = r.modules.find((x) => x.id === 0);
  assert.ok(m !== undefined, "fixture 74 should split into exactly one Metro module with id 0");
  const text = r.files.get(m.file);
  assert.ok(text !== undefined, `split result has no text for ${m.file}`);
  return text;
}

/** Slot immediates of every "pure getter": a function whose only environment
 *  instruction is a single `Load*FromEnvironment`, in a body short enough that
 *  it can only be `return <captured>;`. Sorted, because the getters are
 *  interchangeable and their table order is not this row's property. */
function getterSlots(bytes: Uint8Array): number[] {
  const mod = parse(bytes);
  const out: number[] = [];
  for (let i = 0; i < mod.functions.length; i++) {
    const fn = decodeFunction(mod, i);
    if (fn.instructions.length > 4) continue;
    const env = fn.instructions.filter((insn) => /Environment$/.test(insn.name) && !/^(Create|Get)/.test(insn.name));
    if (env.length !== 1) continue;
    const only = env[0]!;
    if (!only.name.startsWith("Load")) continue;
    out.push(only.operands[2]!.value);
  }
  return out.sort((a, b) => a - b);
}

function recompile(version: Version, source: string): Uint8Array {
  const hermesc = findHermesc(version)!;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-orphan-decl-order-"));
  try {
    const src = join(dir, "module_0.js");
    writeFileSync(src, source);
    const out = join(dir, "out.hbc");
    const r = runHermesc(hermesc, ["-O", "-emit-binary", `-out=${out}`, "module_0.js"], dir);
    assert.equal(r.status, 0, `hermesc v${version} failed: ${r.stderr}`);
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const version of VERSIONS) {
  test(`74-sibling-env-slots v${version}: pulled-in orphan declarations follow the factory's env-slot prologue`, () => {
    if (!existsSync(join(FIXTURE, `v${version}.hbc`))) return;
    const text = moduleFile(fixtureBytes(version));
    const lines = text.split("\n");
    const prologue = lines.findIndex((l) => /^ {2}let _e\d+_0\b/.test(l));
    const firstNested = lines.findIndex((l) => /^ {2}function _fn\d+\(/.test(l));
    assert.ok(prologue >= 0, `v${version}: the factory declares no env slots — fixture shape changed under this test`);
    assert.ok(firstNested >= 0, `v${version}: the factory has no nested function declarations — fixture shape changed under this test`);
    assert.ok(
      prologue < firstNested,
      `v${version}: a function declaration (line ${firstNested + 1}) precedes the factory's env-slot prologue (line ${prologue + 1}); Hermes numbers scope slots in textual declaration order, so that shifts every captured slot`,
    );
  });

  test(`74-sibling-env-slots v${version}: recompiled split module keeps the original getter slot immediates`, (t) => {
    if (!existsSync(join(FIXTURE, `v${version}.hbc`))) return;
    if (findHermesc(version) === null) {
      if (requireOracles()) throw new Error(`hermesc v${version} required (HBC2JS_REQUIRE_ORACLES=1)`);
      t.skip(`hermesc v${version} not found (run tools/get-hermesc.sh ${version})`);
      return;
    }
    const original = fixtureBytes(version);
    const before = getterSlots(original);
    assert.ok(before.length >= 5, `v${version}: expected at least the five barrel getters, found ${before.length} — fixture shape changed under this test`);
    const after = getterSlots(recompile(version, moduleFile(original)));
    assert.deepEqual(after, before, `v${version}: the split module recompiles its getters against different environment slots than the original`);
  });
}
