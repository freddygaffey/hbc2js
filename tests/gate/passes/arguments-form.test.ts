// ACCEPTANCE: spec 23 -- docs/specs/passes/23-arguments-form-literal-forms.md,
// rung `arguments-form` (stage B). Written before the implementation: every
// test that needs the rung is `{ skip: SKIP }` and loads it through a
// *non-literal* dynamic import, so this file typechecks and runs green while
// src/passes/arguments-form/ does not exist. The orchestrator lifts the skips
// in the commit that lands the rung.
//
// Rung-owned properties only: reification-call counts, the mapped-arguments
// refusal (spec 23 section 4.1 R-A3), and the catalogue row PL-06 needs. No
// whole-output comparison against a shared fixture (CLAUDE.md testing rules /
// CONSOLIDATION section B item 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import { parseCatalogueIndex } from "../../../src/passes/catalogue.ts";
import { repoRoot } from "../../support/paths.ts";

const SKIP = "spec 23 acceptance -- unimplemented";
const DIR = ["..", "..", "..", "src", "passes", "arguments-form"].join("/");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function rung(): Promise<{ match: Any; check: Any; argumentsForm: Any }> {
  const [m, c, i] = await Promise.all([import(`${DIR}/match.ts`), import(`${DIR}/check.ts`), import(`${DIR}/index.ts`)]);
  return { match: (m as Any).match, check: (c as Any).check, argumentsForm: (i as Any).argumentsForm };
}

const CONSTRUCTS = join(repoRoot(), "tests", "fixtures", "constructs");
const js = (fixture: string, version: string, mode: "on" | "off" | "none" = "on"): string =>
  decompile(readFileSync(join(CONSTRUCTS, fixture, `${version}.hbc`)), {
    resolveV98Ambiguity: true,
    passes: mode === "none" ? { none: true } : mode === "off" ? { skip: ["arguments-form"] } : {},
  }).code;
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
const REIFY = /__hbc_arguments\(arguments\)/g;
const ALIAS_WRITE = /__hbc_arguments\(arguments\)\[0\] = /g;
const S2_READ = /arguments(\[|\.length)/g;
// Every version fixture 49 and 42 are built for (tests/fixtures/build.sh).
const VERSIONS = ["v84", "v94", "v96", "v98", "v99"];

// ---------------------------------------------------------------------------
// Baseline facts (spec 23 section 1.1). True today; still true after the rung
// lands, because `--passes=none` is byte-identical for ever (PL-05).
// ---------------------------------------------------------------------------

test("baseline (passes=none): every version reifies `arguments` through the helper", () => {
  for (const version of VERSIONS) {
    const base = js("49-arguments-object", version, "none");
    assert.ok(count(base, REIFY) >= 2, `${version}: expected at least 2 __hbc_arguments(arguments) sites, saw ${count(base, REIFY)}`);
    // S2 -- GetArgumentsLength / GetArgumentsPropByVal already print a bare
    // `arguments`; the rung does not own them and they must not be counted as
    // its work (spec 23 section 1.1).
    assert.ok(count(base, S2_READ) >= 5, `${version}: expected the direct arguments reads to be bare already`);
    assert.doesNotMatch(base, /__hbc_arguments\(__hbc_arguments/);
  }
});

test("the mapped-arguments write survives at every version (spec 23 R-A3 refusal)", () => {
  // 49-arguments-object `aliasDemo(a, b)`: a store THROUGH the reified object
  // into slot 0 of a sloppy function with two simple parameters. Rewriting the
  // helper call to a bare `arguments` there would make the store land in `a1`,
  // which Hermes never does (docs/EQUIVALENCE.md section 5.2). The rung must
  // refuse, so this holds with the rung off AND on.
  for (const version of VERSIONS) {
    assert.equal(count(js("49-arguments-object", version), ALIAS_WRITE), 1, `${version}: aliasDemo's write through the reified object must survive`);
  }
});

test("the unmapped-by-construction cases exist in the fixtures (spec 23 section 1.1)", () => {
  for (const version of VERSIONS) {
    // Zero parameters: `toArray()` in 49 (named at v84-96, `_fn3`/`_fn4` at
    // v98/v99, where fn-naming recovers no name). A JS arguments object is
    // unmapped in a zero-parameter function whatever the body does with it.
    assert.match(js("49-arguments-object", version), /function \w*\(\) \{/);
  }
  // Rest parameter: `combine(a1, ...rest)` in 42 -- also unmapped, and the
  // reason `arguments-form` must run after `spread-rest` (spec 23 section 2).
  // Only v84/94/96 recover the rest parameter today; at v98/v99 the same
  // function is emitted as `_fn1(a1)` plus `__hbc_b_copyRestArgs(arguments, 1)`
  // in the body, i.e. an emitted parameter list that IS simple -- which is what
  // spec 23 R-A3 judges, and it judges it conservatively.
  for (const version of ["v84", "v94", "v96"]) assert.match(js("42-rest-params", version), /function combine\(a1, \.\.\./);
  for (const version of ["v98", "v99"]) assert.match(js("42-rest-params", version), /__hbc_b_copyRestArgs\(/);
});

test("PL-06: catalogue row R10 exists and is verified", () => {
  // The same parser checkCatalogue uses, so this test fails for exactly the
  // reasons registration would (only the status cell counts, not the notes).
  const rows = parseCatalogueIndex(readFileSync(join(repoRoot(), "docs", "LOWERING-CATALOGUE.md"), "utf8"));
  const row = rows.get("R10");
  assert.ok(row !== undefined, "docs/LOWERING-CATALOGUE.md has no R10 row for arguments-form");
  assert.ok(row.idiom.includes("arguments-form"), `R10 must be the arguments-form row, is: ${row.idiom}`);
  assert.ok(row.status.includes("✅") && !/single-version/i.test(row.status), `R10 status must be verified, is: ${row.status}`);
});

// ---------------------------------------------------------------------------
// Rung shape and ordering (spec 23 section 2).
// ---------------------------------------------------------------------------

test("arguments-form is a stage-B rung on catalogue row R10, after spread-rest, before the naming rungs", { skip: SKIP }, async () => {
  const { argumentsForm } = await rung();
  assert.equal(argumentsForm.stage, "B");
  assert.deepEqual([...(argumentsForm.catalogue as (number | string)[])], ["R10"]);
  for (const dep of ["expr-rebuild", "spread-rest"]) assert.ok((argumentsForm.after as string[]).includes(dep), `missing after: ${dep}`);
  for (const dep of ["fn-naming", "reg-split", "var-naming"]) assert.ok((argumentsForm.before as string[]).includes(dep), `missing before: ${dep}`);
  const { REGISTRY, enabledPasses } = (await import(["..", "..", "..", "src", "passes", "registry.ts"].join("/"))) as Any;
  const names = (REGISTRY as { name: string }[]).map((p) => p.name);
  assert.ok(names.includes("arguments-form"));
  assert.ok(names.indexOf("arguments-form") < names.indexOf("var-naming"));
  assert.doesNotThrow(() => enabledPasses({}));
});

test("arguments-form: a body with no helper call is a fixed point without consulting the context (R-A0/PL-08)", { skip: SKIP }, async () => {
  const { match } = await rung();
  const body = [{ k: "return", value: { k: "member", obj: { k: "ident", name: "arguments" }, prop: { k: "num", value: 0 }, computed: true } }];
  assert.equal(match(body as Any, { fnBody: body } as Any), null);
});

// ---------------------------------------------------------------------------
// Fixture properties (spec 23 section 5).
// ---------------------------------------------------------------------------

test("arguments-form replaces the helper call where nothing can alias", { skip: SKIP }, () => {
  for (const version of VERSIONS) {
    const on = js("49-arguments-object", version);
    const off = js("49-arguments-object", version, "off");
    assert.ok(count(on, REIFY) < count(off, REIFY), `${version}: expected fewer reification calls with the rung on (${count(on, REIFY)} vs ${count(off, REIFY)})`);
    // `toArray()` has no parameters, so its reified object is unmapped.
    const fn = on.slice(on.indexOf("function toArray()"), on.indexOf("function sumAll"));
    assert.doesNotMatch(fn, /__hbc_arguments/);
    assert.match(fn, /slice\.call\(arguments\)|call\(arguments\)/);
  }
});

test("arguments-form owns only the helper call: the direct reads and the control flow are untouched", { skip: SKIP }, () => {
  for (const fixture of ["49-arguments-object", "42-rest-params"]) {
    for (const version of VERSIONS) {
      const on = js(fixture, version);
      const off = js(fixture, version, "off");
      assert.equal(count(on, S2_READ) - count(off, S2_READ), count(off, REIFY) - count(on, REIFY), `${fixture} ${version}: every new bare arguments must come from a replaced helper call`);
      for (const [what, re] of [
        ["functions", /\bfunction \w*\(/g],
        ["loops", /\b(while|for) \(/g],
        ["returns", /\breturn /g],
      ] as const) {
        assert.equal(count(on, re), count(off, re), `${fixture} ${version}: arguments-form must not change the number of ${what}`);
      }
    }
  }
});

test("arguments-form refuses a sloppy function whose parameter is written (R-A3 case a)", { skip: SKIP }, async () => {
  const { match } = await rung();
  // `function f(a1) { a1 = 99; return __hbc_arguments(arguments)[0]; }` -- the
  // parameter store is visible through a mapped arguments object.
  const body = [
    { k: "expr", expr: { k: "assign", target: { k: "ident", name: "a1" }, value: { k: "num", value: 99 } } },
    { k: "return", value: { k: "member", obj: { k: "call", callee: { k: "ident", name: "__hbc_arguments" }, args: [{ k: "ident", name: "arguments" }] }, prop: { k: "num", value: 0 }, computed: true } },
  ];
  assert.equal(match(body as Any, { fnBody: body, fnParams: { names: ["a1"], simple: true } } as Any), null);
});
