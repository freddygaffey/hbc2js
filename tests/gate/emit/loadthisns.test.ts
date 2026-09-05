// Regression test for docs/BUGS.md's 2026-09-01 row "LoadThisNS lowering"
// (buckets `diff:GetById/LoadConstNull` and `diff:GetEnvironment/LoadConstNull`
// on E2E tier 1).
//
// `hermesc` compiles a bare `this` inside a NON-strict function to exactly
// `LoadThisNS`, because the sloppy-mode call protocol has already performed the
// coercion the opcode names: ES2024 10.2.1.2 OrdinaryCallBindThis maps
// null/undefined to the global object and boxes a primitive receiver before the
// body runs. The emitter used to print the coercion explicitly, which denotes
// the same value but never round-trips back to the same bytecode. It now prints
// `this` in a sloppy function and keeps the explicit form in a strict one,
// where the call protocol leaves `this` alone.
//
// Property assertions only: 50-this-binding and 36-class-getters-setters are
// shared fixtures (CLAUDE.md testing rules).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { parseM4 } from "../../support/m4.ts";
import { decompile } from "../../../src/decompile.ts";
import { emitModule } from "../../../src/emit/index.ts";
import type { Op } from "../../support/synth-module.ts";
import { fakeFunction, graphOf, realCfg, ret } from "../../support/synth-module.ts";
import type { ModuleAnalysis } from "../../../src/cfg/types.ts";
import type { HbcModule } from "../../../src/parse/types.ts";

const CONSTRUCTS = join(repoRoot(), "tests", "fixtures", "constructs");
const GOLDEN = join(repoRoot(), "tests", "golden", "disasm", "constructs");
const VERSIONS = ["v84", "v94", "v96", "v98", "v99"] as const;

/** The shape the emitter used to print for every `LoadThisNS`. */
const THIS_COERCION = /this === null \|\| this === undefined \? globalThis : Object\(this\)/g;
/** `this` as a value, not as part of `globalThis` or a property name. */
const BARE_THIS = /(?<![.\w$])this(?![\w$])/g;

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

function js(fixture: string, version: string): string {
  return decompile(new Uint8Array(readFileSync(join(CONSTRUCTS, fixture, `${version}.hbc`))), { resolveV98Ambiguity: true, moduleName: fixture }).code;
}

/** How many `LoadThisNS` the compiler actually emitted, read off the disassembly golden. */
function loadThisNsCount(fixture: string, version: string): number {
  return count(readFileSync(join(GOLDEN, fixture, `${version}.txt`), "utf8"), /\bLoadThisNS\b/g);
}

test('BUGS "LoadThisNS lowering": every LoadThisNS in a sloppy fixture prints a bare this, at all five versions', (t) => {
  if (!existsSync(join(CONSTRUCTS, "50-this-binding", "v99.hbc"))) {
    t.skip("construct fixtures not built - run tests/fixtures/constructs/build.sh (INCONCLUSIVE, not a failure)");
    return;
  }
  for (const version of VERSIONS) {
    if (!existsSync(join(CONSTRUCTS, "50-this-binding", `${version}.hbc`))) continue;
    // 50-this-binding is entirely sloppy: no function in it is strict, so every
    // LoadThisNS must take the bare form.
    const code = js("50-this-binding", version);
    assert.doesNotMatch(code, /use strict/, `${version}: premise - 50-this-binding has no strict function`);
    const opcodes = loadThisNsCount("50-this-binding", version);
    assert.ok(opcodes >= 7, `${version}: premise - the fixture exercises LoadThisNS (${opcodes} of them)`);
    assert.equal(count(code, THIS_COERCION), 0, `${version}: no sloppy LoadThisNS may print the explicit coercion any more`);
    assert.ok(count(code, BARE_THIS) >= opcodes, `${version}: at least one bare this per LoadThisNS (${count(code, BARE_THIS)} < ${opcodes})`);
  }
});

test('BUGS "LoadThisNS lowering": a strict function is untouched - it never prints the coercion and never gains a this', (t) => {
  if (!existsSync(join(CONSTRUCTS, "36-class-getters-setters", "v99.hbc"))) {
    t.skip("construct fixtures not built (INCONCLUSIVE, not a failure)");
    return;
  }
  for (const version of VERSIONS) {
    if (!existsSync(join(CONSTRUCTS, "36-class-getters-setters", `${version}.hbc`))) continue;
    const code = js("36-class-getters-setters", version);
    // The fixture's class methods are strict and load `this` with LoadParam 0;
    // its object-literal accessors are sloppy and use LoadThisNS. Both print
    // `this`, and nothing in the file prints the ternary.
    assert.match(code, /"use strict"/, `${version}: premise - the fixture has strict functions`);
    assert.equal(count(code, THIS_COERCION), 0, version);
    assert.ok(count(code, BARE_THIS) >= loadThisNsCount("36-class-getters-setters", version), version);
  }
});

// ---------------------------------------------------------------------------
// Strictness is read off the function header flag the emitter uses for the
// `"use strict"` directive itself (src/emit/function.ts). Synthetic, because
// hermesc never emits LoadThisNS inside a strict function - there is no fixture
// for that half of the branch.
// ---------------------------------------------------------------------------

const DONOR = join(CONSTRUCTS, "22-nested-closures-counters", "v99.hbc");

function emitOne(ops: readonly Op[], strictMode: boolean): string {
  const donor = parseM4(new Uint8Array(readFileSync(DONOR))).module;
  const base = fakeFunction(0, ops);
  const fn = { ...base, header: { ...base.header, flags: { ...base.header.flags, strictMode } } } as typeof base;
  const cfg = realCfg(fn);
  const module = { ...donor, header: { ...donor.header, globalCodeIndex: 0, functionCount: 1 }, functions: [{ index: 0 }] } as unknown as HbcModule;
  const analysis: ModuleAnalysis = {
    module,
    envGraph: graphOf(new Map([[0, ops]])),
    kinds: [],
    cfg: () => cfg,
    decoded: () => fn,
    options: { strictEnv: false, maxBlocks: 100000, checkInvariants: false },
    diagnostics: [],
  } as unknown as ModuleAnalysis;
  return emitModule(analysis, { strictEnv: false, provenanceComments: false, moduleName: "synthetic.hbc" }).code;
}

const loadThisNs = (r: number): Op => ({ name: "LoadThisNS", ops: [["reg", r]] });
const coerceThisNs = (dst: number, src: number): Op => ({ name: "CoerceThisNS", ops: [["reg", dst], ["reg", src]] });
const loadUndefined = (r: number): Op => ({ name: "LoadConstUndefined", ops: [["reg", r]] });

test('BUGS "LoadThisNS lowering": the sloppy/strict split is driven by the header strictMode flag', (t) => {
  if (!existsSync(DONOR)) {
    t.skip("donor fixture not built (INCONCLUSIVE, not a failure)");
    return;
  }
  const sloppy = emitOne([loadThisNs(0), ret(0)], false);
  assert.equal(count(sloppy, THIS_COERCION), 0, "a sloppy LoadThisNS is a bare this");
  assert.ok(count(sloppy, BARE_THIS) >= 1, "a sloppy LoadThisNS still loads this");

  const strict = emitOne([loadThisNs(0), ret(0)], true);
  assert.match(strict, /"use strict"/, "premise - the flag is the one that prints the directive");
  assert.equal(count(strict, THIS_COERCION), 1, "a strict function's this is NOT coerced by the call protocol, so the coercion stays explicit");
});

test('BUGS "LoadThisNS lowering": CoerceThisNS keeps its explicit coercion in a sloppy function', (t) => {
  if (!existsSync(DONOR)) {
    t.skip("donor fixture not built (INCONCLUSIVE, not a failure)");
    return;
  }
  // CoerceThisNS coerces an arbitrary register, not the receiver: nothing has
  // coerced it already, so the fix must not reach it.
  const code = emitOne([loadUndefined(1), coerceThisNs(0, 1), ret(0)], false);
  assert.match(code, /=== null \|\| \w+ === undefined \? globalThis : Object\(\w+\)/, "CoerceThisNS still prints the coercion");
});
