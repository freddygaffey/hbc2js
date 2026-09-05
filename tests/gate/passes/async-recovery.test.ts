// ACCEPTANCE: spec 25 — docs/specs/passes/25-yield-async-recovery.md, rung
// `async-recovery` (stage B, generator-shape checker, `after:
// ["yield-recovery"]`). Written before the implementation: every test that
// needs the rung is `{ skip: SKIP }` and loads it through a *non-literal*
// dynamic import, so this file typechecks and runs green while
// src/passes/async-recovery/ does not exist. The orchestrator lifts the skips
// in the commit that lands the rung.
//
// Rung-owned properties only: driver-call shape, per-version driver name,
// refusal evidence, framework premises. No whole-output comparison against a
// shared fixture (CLAUDE.md testing rules / CONSOLIDATION section B item 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import { repoRoot } from "../../support/paths.ts";

const DIR = ["..", "..", "..", "src", "passes", "async-recovery"].join("/");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function rung(): Promise<{ match: Any; check: Any; asyncRecovery: Any }> {
  const [m, c, i] = await Promise.all([import(`${DIR}/match.ts`), import(`${DIR}/check.ts`), import(`${DIR}/index.ts`)]);
  return { match: (m as Any).match, check: (c as Any).check, asyncRecovery: (i as Any).asyncRecovery };
}

const CONSTRUCTS = join(repoRoot(), "tests", "fixtures", "constructs");
const js = (fixture: string, version: string, skip: readonly string[] = []): string =>
  decompile(readFileSync(join(CONSTRUCTS, fixture, `${version}.hbc`)), { resolveV98Ambiguity: true, passes: skip.length > 0 ? { skip } : {} }).code;
const base = (fixture: string, version: string): string =>
  decompile(readFileSync(join(CONSTRUCTS, fixture, `${version}.hbc`)), { resolveV98Ambiguity: true, passes: { none: true } }).code;
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

// The driver, spec 25 section 1.6. Also matches the helper *definition*, so a
// site count is the match count minus one.
const SPAWN = /__hbc_b_spawnAsync/g;
const MAKE = /__hbc_makeGenerator\(/g;
const LOWERED = /__hbc_makeGeneratorLowered\(/g;
const THIS_COERCION = /this === null \|\| this === undefined \? globalThis : Object\(this\)/g;
// The stub hands the driver its own receiver: `rN = this;` immediately before
// the `Reflect.apply` that calls the driver with rN as its second argument.
// Until 2026-09-05 that receiver printed as THIS_COERCION; inside a sloppy
// function the call protocol has already applied exactly that coercion
// (ES2024 10.2.1.2), so the emitter now prints it bare -- same value, shorter,
// and it round-trips back through hermesc (docs/BUGS.md 2026-09-01 "LoadThisNS
// lowering"; cross-rung edit recorded as PUSHBACK P-31).
const DRIVER_THIS = /(\w+) = this;\s*\w+ = Reflect\.apply\(\w+, \w+, \[\w+, \1, \w+\]\);/g;
const REIFIED_ARGS = /__hbc_arguments\(arguments\)/g;

const ALL_VERSIONS = ["v84", "v94", "v96", "v98", "v99"] as const;
const ASYNC_FIXTURES = ["27-async-await-basic", "28-async-await-error"] as const;
// site count (driver calls) per fixture, identical at every version
const SITES: Record<string, number> = { "27-async-await-basic": 1, "28-async-await-error": 2 };

// ---------------------------------------------------------------------------
// Baseline facts (spec 25 section 1.6) — true now, and still true after the
// rung lands because `--passes=none` is byte-identical (PL-05).
// ---------------------------------------------------------------------------

test("baseline: the async driver is __hbc_b_spawnAsync at ALL five versions (spec 25 section 1.6, P-25)", () => {
  for (const version of ALL_VERSIONS) {
    for (const fixture of ASYNC_FIXTURES) {
      const s = base(fixture, version);
      assert.equal(count(s, SPAWN), SITES[fixture]! + 1, `${fixture} ${version}: driver sites + helper definition`);
      assert.doesNotMatch(s, /__hbc_b_makeAsyncIterator/, `${fixture} ${version}: today's tables never resolve the v99 driver to makeAsyncIterator`);
    }
  }
});

test("baseline: the driver call shape is d(factory, coercedThis, reifiedArguments) at every version", () => {
  for (const version of ALL_VERSIONS) {
    const s = base("27-async-await-basic", version);
    assert.equal(count(s, DRIVER_THIS), 1, `${version}: the stub hands the driver its own this`);
    assert.equal(count(s, THIS_COERCION), 0, `${version}: a sloppy stub's receiver needs no explicit coercion`);
    assert.equal(count(s, REIFIED_ARGS), 1, `${version}: the stub reifies its own arguments`);
  }
});

test("baseline: the factory the driver is handed is opcode-era at <=96 and lowered at >=97 (R-A4 evidence)", () => {
  for (const version of ["v84", "v94", "v96"] as const) {
    for (const fixture of ASYNC_FIXTURES) {
      const s = base(fixture, version);
      assert.ok(count(s, MAKE) >= 2, `${fixture} ${version}: an opcode-era generator sits under the driver`);
      assert.equal(count(s, LOWERED), 0, `${fixture} ${version}`);
    }
  }
  for (const version of ["v98", "v99"] as const) {
    for (const fixture of ASYNC_FIXTURES) {
      const s = base(fixture, version);
      assert.equal(count(s, MAKE), 0, `${fixture} ${version}`);
      assert.ok(count(s, LOWERED) >= 2, `${fixture} ${version}: still lowered, so R-A4 applies until gen-lowered lands`);
    }
  }
});

test("P-25 evidence: the builtin tables resolve the v98/v99 async driver to spawnAsync, not makeAsyncIterator", async () => {
  const v98 = (await import(["..", "..", "..", "src", "tables", "generated", "builtins-hbc98-late.ts"].join("/"))) as Any;
  const v99 = (await import(["..", "..", "..", "src", "tables", "generated", "builtins-hbc99-mar2026.ts"].join("/"))) as Any;
  const nameAt = (table: Any, n: number): string => (table.builtins as { n: number; name: string }[]).find((b) => b.n === n)!.name;
  // docs/lowering/async-await.md section 3 records "#57 spawnAsync at v98,
  // #58 makeAsyncIterator at v99" (T13). The v99 reading predates
  // patchHbc99Mar2026Builtins (src/tables/generated/PROVENANCE.md), which
  // shifted 56-60; b58 at v99 is spawnAsync today.
  assert.equal(nameAt(v98.HBC98_LATE, 57), "spawnAsync");
  assert.equal(nameAt(v99.HBC99_MAR2026, 58), "spawnAsync");
});

test("baseline: 28-async-await-error suspends inside its try region (R-Y7 evidence)", () => {
  for (const version of ["v84", "v94", "v96"] as const) {
    const s = base("28-async-await-error", version);
    // The dispatcher, the suspend site and the arm all live inside the same
    // emitted `try`, which is what makes arm inlining region-safe.
    assert.match(s, /try \{[\s\S]*switch \(__state\)/, `${version}: the dispatcher is inside the try`);
    assert.ok(count(s, /\} catch \(/g) >= 1, version);
  }
});

// PUSHBACK P-29 (see tests/gate/passes/yield-recovery.test.ts): comparing the
// default pipeline against `--passes=none` and requiring the driver counts to
// be equal is not PL-05, and it asserts that this rung does nothing. Re-pointed
// at the permanent property: no rung *other* than the two spec-25 rungs touches
// the async idiom.
test("baseline: the async idiom is untouched by every rung except yield-recovery/async-recovery", () => {
  for (const version of ALL_VERSIONS) {
    for (const fixture of ASYNC_FIXTURES) {
      for (const [what, re, alsoSkip] of [
        ["driver references", SPAWN, []],
        // `DRIVER_THIS` is a passes-OFF shape (it spells the receiver into a
        // `Reflect.apply` argument list); `call-shape` rewrites that call, so it
        // is not a pipeline-invariant marker and is asserted above instead.
        ["this coercions", THIS_COERCION, []],
        // PUSHBACK P-34: spec 23's `arguments-form` (catalogue row R10) owns
        // exactly this expression -- rewriting `__hbc_arguments(arguments)` to
        // a bare `arguments` is its whole purpose -- so it is the one further
        // rung that legitimately touches this marker. Narrowed, not weakened:
        // the loop below still proves no *other* rung does.
        ["reified arguments", REIFIED_ARGS, ["arguments-form"]],
      ] as const) {
        assert.equal(count(js(fixture, version, ["yield-recovery", "async-recovery", ...alsoSkip]), re), count(base(fixture, version), re), `${fixture} ${version}: ${what}`);
      }
    }
  }
});

// PUSHBACK P-34, second half: `arguments-form` is the ONLY rung besides the
// two spec-25 rungs that may move the reified-arguments marker. Skipping it
// alone restores the passes-off count on every async fixture at every version.
test("baseline: `arguments-form` is the only other rung that rewrites the async stub's reified arguments", () => {
  for (const version of ALL_VERSIONS) {
    for (const fixture of ASYNC_FIXTURES) {
      const off = count(base(fixture, version), REIFIED_ARGS);
      assert.equal(count(js(fixture, version, ["yield-recovery", "async-recovery", "arguments-form"]), REIFIED_ARGS), off, `${fixture} ${version}: with arguments-form skipped`);
      assert.ok(count(js(fixture, version, ["yield-recovery", "async-recovery"]), REIFIED_ARGS) < off, `${fixture} ${version}: arguments-form does rewrite it`);
    }
  }
});

// ---------------------------------------------------------------------------
// Framework and registration premises.
// ---------------------------------------------------------------------------

// PUSHBACK P-28 (see tests/gate/passes/yield-recovery.test.ts): the shipped
// form asserted F25-1 had not been implemented yet, which cannot hold once the
// rung it exists for lands. Same two facts, asserted positively.
test("F25-1: src/emit/ast.ts declares the await node and the async flag", () => {
  const ast = readFileSync(join(repoRoot(), "src", "emit", "ast.ts"), "utf8");
  assert.match(ast, /k: "await"/);
  assert.match(ast, /readonly async\?/);
});

test("PL-06 premise: catalogue row 19 is verified and points at spec 25", () => {
  const cat = readFileSync(join(repoRoot(), "docs", "LOWERING-CATALOGUE.md"), "utf8");
  const row = cat.split("\n").find((l) => l.startsWith("| 19 |"));
  assert.ok(row, "catalogue row 19 must exist");
  assert.match(row, /✅/);
  assert.match(row, /spec 25/i);
});

test("spec 25 section 1.8: the rn-template bundle contains no async driver, so this rung cannot move its hash", () => {
  const bytes = readFileSync(join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc"));
  const s = decompile(bytes, { passes: { none: true } }).code;
  assert.equal(count(s, SPAWN), 0);
  assert.doesNotMatch(s, /__hbc_b_makeAsyncIterator/);
});

// ---------------------------------------------------------------------------
// Skipped until the rung exists (spec 25 section 5).
// ---------------------------------------------------------------------------

test("async-recovery is a stage-B rung on catalogue row 19, after yield-recovery and before renaming", async () => {
  const { asyncRecovery } = await rung();
  assert.equal(asyncRecovery.stage, "B");
  assert.deepEqual([...(asyncRecovery.catalogue as (number | string)[])], [19]);
  assert.ok((asyncRecovery.after as string[]).includes("yield-recovery"));
  // `after: ["gen-lowered"]` cannot be declared until that rung exists:
  // enabledPasses throws E_PASS_ORDER for an unknown dependency (spec 25
  // section 2). Registration must therefore not name it yet.
  assert.ok(!(asyncRecovery.after as string[]).includes("gen-lowered"));
  const { REGISTRY, enabledPasses } = (await import(["..", "..", "..", "src", "passes", "registry.ts"].join("/"))) as Any;
  const names = (REGISTRY as { name: string }[]).map((p) => p.name);
  assert.ok(names.indexOf("yield-recovery") < names.indexOf("async-recovery"));
  assert.ok(names.indexOf("async-recovery") < names.indexOf("fn-naming"));
  assert.doesNotThrow(() => enabledPasses({}));
});

test("async-recovery's versions predicate accepts every version", async () => {
  const { asyncRecovery } = await rung();
  const v = asyncRecovery.versions as ((n: number, layout: string) => boolean) | undefined;
  for (const n of [84, 94, 96, 98, 99]) assert.equal(v === undefined || v(n, "C"), true, `v${n}`);
});

test("async-recovery: a body with no spawn wrapper is a fixed point (PL-08, R-A0)", async () => {
  const { match } = await rung();
  assert.equal(match([{ k: "return", arg: null }] as Any, {} as Any), null);
});

test("async-recovery recovers 27-async-await-basic into async/await at v84/v94/v96", () => {
  for (const version of ["v84", "v94", "v96"] as const) {
    const on = js("27-async-await-basic", version);
    const off = js("27-async-await-basic", version, ["async-recovery"]);
    assert.ok(count(on, SPAWN) < count(off, SPAWN), `${version}: the driver call is consumed`);
    assert.match(on, /async function /);
    assert.equal(count(on, /\bawait /g), 3, `${version}: three awaits`);
    assert.doesNotMatch(on, /\byield /, `${version}: every recovered yield became an await (R-A5)`);
  }
});

test("async-recovery keeps 28-async-await-error's await inside its try (R-Y7)", () => {
  const on = js("28-async-await-error", "v94");
  const off = js("28-async-await-error", "v94", ["async-recovery"]);
  assert.equal(count(on, /\btry \{/g), count(off, /\btry \{/g), "no try region may be added or removed");
  assert.match(on, /try \{[\s\S]*await /);
});

test("async-recovery refuses at v98/v99 with R-A4 until gen-lowered lands", () => {
  for (const version of ["v98", "v99"] as const) {
    for (const fixture of ASYNC_FIXTURES) {
      const on = js(fixture, version);
      const off = js(fixture, version, ["async-recovery"]);
      assert.equal(count(on, SPAWN), count(off, SPAWN), `${fixture} ${version}: nothing is rewritten while the inner body is still lowered`);
      assert.doesNotMatch(on, /async function /, `${fixture} ${version}`);
    }
  }
});

test("async-recovery's checker rejects an `after` carrying a yield it did not produce (R-A5)", async () => {
  const { check } = await rung();
  const before = { k: "func", name: "f", params: [], body: [] };
  const after = { k: "func", name: "f", params: [], body: [{ k: "expr", expr: { k: "yield", arg: null, delegate: false } }], async: true };
  const result = check(before as Any, after as Any, { applied: [] } as Any) as { ok: boolean; reason?: string };
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /yield|await/i);
});

// ---------------------------------------------------------------------------
// Regression: docs/BUGS.md 2026-09-05 `arguments-form` vs `async-recovery`.
// The stage-B hook runs per function, innermost first (`src/emit/index.ts`
// emits a nested function before its parent and runs `opts.astPasses` on
// each), so `arguments-form` has already canonicalised the async stub's own
// body by the time `async-recovery` -- which matches the stub from its
// *parent's* statement list -- ever sees it. Registry order cannot change
// that. Both operand forms are therefore the stub's own arguments and both
// must be accepted. RED before the `isOwnArguments` fix (reason
// `this-coercion`), green after.
// ---------------------------------------------------------------------------

const asyncStub = (argsOperand: Any): Any => ({
  k: "func",
  name: "f",
  params: [],
  body: [
    { k: "func", name: "g", params: [], generator: true, body: [{ k: "expr", expr: { k: "yield", arg: { k: "lit", text: "1" }, delegate: false } }] },
    { k: "return", arg: { k: "call", callee: { k: "ident", name: "__hbc_b_spawnAsync" }, args: [{ k: "ident", name: "g" }, { k: "this" }, argsOperand] } },
  ],
});

test("R-A2 accepts both arguments operands: `arguments-form`'s bare read and the raw reify call", async () => {
  const { recover } = (await import(`${DIR}/recover.ts`)) as Any;
  const bare = recover(asyncStub({ k: "argumentsObject" })) as { ok: boolean; reason?: string; awaits?: number };
  assert.equal(bare.ok, true, `bare \`arguments\` must be accepted (got ${String(bare.reason)})`);
  assert.equal(bare.awaits, 1);
  const reified = recover(asyncStub({ k: "call", callee: { k: "ident", name: "__hbc_arguments" }, args: [{ k: "argumentsObject" }] })) as { ok: boolean };
  assert.equal(reified.ok, true, "the raw emitter form must still be accepted");
  const alien = recover(asyncStub({ k: "ident", name: "someoneElsesArgs" })) as { ok: boolean; reason?: string };
  assert.equal(alien.ok, false, "R-A2 stays sound: a foreign value is not the stub's own arguments");
  assert.equal(alien.reason, "this-coercion");
});

test("cross-spec: async-recovery still recovers 27/28 with `arguments-form` enabled (BUGS 2026-09-05)", () => {
  for (const version of ["v84", "v94", "v96"] as const) {
    const on = js("27-async-await-basic", version);
    assert.equal(count(on, REIFIED_ARGS), 0, `${version}: arguments-form ran on the stub`);
    assert.match(on, /async function /, `${version}: and the async idiom survived it`);
    const without = js("27-async-await-basic", version, ["arguments-form"]);
    assert.equal(count(on, SPAWN), count(without, SPAWN), `${version}: the same number of driver calls is consumed either way`);
  }
  const err = js("28-async-await-error", "v94");
  assert.match(err, /try \{[\s\S]*await /, "28's await stays inside its try with arguments-form on");
});
