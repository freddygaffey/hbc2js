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

const SKIP = "spec 25 acceptance -- unimplemented";
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

test("baseline: the async idiom is identical with passes on and off (PL-05)", () => {
  for (const version of ALL_VERSIONS) {
    for (const fixture of ASYNC_FIXTURES) {
      for (const [what, re] of [
        ["driver references", SPAWN],
        // Zero on both sides since docs/BUGS.md "LoadThisNS lowering" landed; kept
        // so a rung that reintroduces an explicit coercion on one side is caught.
        ["this coercions", THIS_COERCION],
        ["reified arguments", REIFIED_ARGS],
      ] as const) {
        assert.equal(count(js(fixture, version), re), count(base(fixture, version), re), `${fixture} ${version}: ${what}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Framework and registration premises.
// ---------------------------------------------------------------------------

test("F25-1 premise: src/emit/ast.ts has no await node today", () => {
  const ast = readFileSync(join(repoRoot(), "src", "emit", "ast.ts"), "utf8");
  assert.doesNotMatch(ast, /k: "await"/);
  assert.doesNotMatch(ast, /readonly async\?/);
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

test("async-recovery is a stage-B rung on catalogue row 19, after yield-recovery and before renaming", { skip: SKIP }, async () => {
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

test("async-recovery's versions predicate accepts every version", { skip: SKIP }, async () => {
  const { asyncRecovery } = await rung();
  const v = asyncRecovery.versions as ((n: number, layout: string) => boolean) | undefined;
  for (const n of [84, 94, 96, 98, 99]) assert.equal(v === undefined || v(n, "C"), true, `v${n}`);
});

test("async-recovery: a body with no spawn wrapper is a fixed point (PL-08, R-A0)", { skip: SKIP }, async () => {
  const { match } = await rung();
  assert.equal(match([{ k: "return", arg: null }] as Any, {} as Any), null);
});

test("async-recovery recovers 27-async-await-basic into async/await at v84/v94/v96", { skip: SKIP }, () => {
  for (const version of ["v84", "v94", "v96"] as const) {
    const on = js("27-async-await-basic", version);
    const off = js("27-async-await-basic", version, ["async-recovery"]);
    assert.ok(count(on, SPAWN) < count(off, SPAWN), `${version}: the driver call is consumed`);
    assert.match(on, /async function /);
    assert.equal(count(on, /\bawait /g), 3, `${version}: three awaits`);
    assert.doesNotMatch(on, /\byield /, `${version}: every recovered yield became an await (R-A5)`);
  }
});

test("async-recovery keeps 28-async-await-error's await inside its try (R-Y7)", { skip: SKIP }, () => {
  const on = js("28-async-await-error", "v94");
  const off = js("28-async-await-error", "v94", ["async-recovery"]);
  assert.equal(count(on, /\btry \{/g), count(off, /\btry \{/g), "no try region may be added or removed");
  assert.match(on, /try \{[\s\S]*await /);
});

test("async-recovery refuses at v98/v99 with R-A4 until gen-lowered lands", { skip: SKIP }, () => {
  for (const version of ["v98", "v99"] as const) {
    for (const fixture of ASYNC_FIXTURES) {
      const on = js(fixture, version);
      const off = js(fixture, version, ["async-recovery"]);
      assert.equal(count(on, SPAWN), count(off, SPAWN), `${fixture} ${version}: nothing is rewritten while the inner body is still lowered`);
      assert.doesNotMatch(on, /async function /, `${fixture} ${version}`);
    }
  }
});

test("async-recovery's checker rejects an `after` carrying a yield it did not produce (R-A5)", { skip: SKIP }, async () => {
  const { check } = await rung();
  const before = { k: "func", name: "f", params: [], body: [] };
  const after = { k: "func", name: "f", params: [], body: [{ k: "expr", expr: { k: "yield", arg: null, delegate: false } }], async: true };
  const result = check(before as Any, after as Any, { applied: [] } as Any) as { ok: boolean; reason?: string };
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /yield|await/i);
});
