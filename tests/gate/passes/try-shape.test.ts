// ACCEPTANCE: spec 22 — docs/specs/passes/22-try-shape-try-clean.md, rung
// `try-shape` (stage A, annotation-only). Written before the implementation:
// every test that needs the rung is `{ skip: SKIP }` and loads it through a
// *non-literal* dynamic import, so this file typechecks and runs green while
// src/passes/try-shape/ does not exist. The orchestrator lifts the skips in
// the commit that lands the rung.
//
// Rung-owned properties only: guard counts, `catch { }` recovery, the
// dispatch-nest refusal, and the annotation-only invariant (the rung changes
// no control flow). No whole-output comparison against a shared fixture
// (CLAUDE.md testing rules / CONSOLIDATION section B item 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import { repoRoot } from "../../support/paths.ts";

const SKIP = "spec 22 acceptance -- unimplemented";
const DIR = ["..", "..", "..", "src", "passes", "try-shape"].join("/");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function rung(): Promise<{ match: Any; check: Any; tryShape: Any }> {
  const [m, c, i] = await Promise.all([import(`${DIR}/match.ts`), import(`${DIR}/check.ts`), import(`${DIR}/index.ts`)]);
  return { match: (m as Any).match, check: (c as Any).check, tryShape: (i as Any).tryShape };
}

const CONSTRUCTS = join(repoRoot(), "tests", "fixtures", "constructs");
const js = (fixture: string, version: string, skip: readonly string[] = []): string =>
  decompile(readFileSync(join(CONSTRUCTS, fixture, `${version}.hbc`)), { resolveV98Ambiguity: true, passes: skip.length > 0 ? { skip } : {} }).code;
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
const GUARD = /if \(!\(__pc >= -?\d+ && __pc <= -?\d+\)\)/g;
const PC_STORE = /__pc = -?\d+/g;
// Non-global twins: assert.match/doesNotMatch use RegExp.test, which advances
// lastIndex on a /g regex and would make the second call in a loop lie.
const GUARD1 = new RegExp(GUARD.source);
const PC_STORE1 = new RegExp(PC_STORE.source);

// ---------------------------------------------------------------------------
// Rung shape and ordering (spec 22 section 7).
// ---------------------------------------------------------------------------

test("try-shape is a stage-A rung on catalogue row 11, ordered before label-clean", { skip: SKIP }, async () => {
  const { tryShape } = await rung();
  assert.equal(tryShape.stage, "A");
  assert.deepEqual([...(tryShape.catalogue as (number | string)[])], [11]);
  assert.ok((tryShape.before as string[]).includes("label-clean"));
  // `after: ["finally-dedup"]` cannot be declared until that rung exists:
  // enabledPasses throws E_PASS_ORDER for an unknown dependency (spec 22
  // section 7). Registration must therefore not name it yet.
  const { REGISTRY, enabledPasses } = (await import(["..", "..", "..", "src", "passes", "registry.ts"].join("/"))) as Any;
  const names = (REGISTRY as { name: string }[]).map((p) => p.name);
  assert.ok(names.includes("try-shape"));
  assert.ok(names.indexOf("try-shape") < names.indexOf("label-clean"));
  assert.doesNotThrow(() => enabledPasses({}));
});

test("try-shape: an already-annotated try is a fixed point without consulting the context (P0/PL-08)", { skip: SKIP }, async () => {
  const { match } = await rung();
  const node = { k: "try", region: 0, cfgBlock: 3, body: { k: "block", cfgBlock: 3 }, handler: { k: "block", cfgBlock: 4 }, catchRegister: 6, shape: { bindsExc: true, guard: "needed" } };
  assert.equal(match(node as Any, {} as Any), null);
});

// ---------------------------------------------------------------------------
// Fixture properties (spec 22 section 7).
// ---------------------------------------------------------------------------

for (const version of ["v94", "v99"]) {
  test(`try-shape drops the redundant range guard in 15-catch-without-binding at ${version}`, { skip: SKIP }, () => {
    const on = js("15-catch-without-binding", version);
    const off = js("15-catch-without-binding", version, ["try-shape"]);
    // The over-reaching block of `tryParse`'s region is the `return` block:
    // it cannot throw, so the guard is provably always true (spec 22 4.1).
    assert.ok(count(on, GUARD) < count(off, GUARD), `expected fewer guards with try-shape on (${count(on, GUARD)} vs ${count(off, GUARD)})`);
    const fn = on.slice(on.indexOf("tryParse"), on.indexOf("unreliable"));
    assert.doesNotMatch(fn, GUARD1);
    // With no guard left in the function, the emitter needs no __pc at all.
    assert.doesNotMatch(fn, PC_STORE1);
    // The handler never reads the catch register, so the binding goes too.
    assert.match(fn, /\} catch \{/);
  });

  test(`try-shape keeps the guard whose over-reaching block can throw at ${version}`, { skip: SKIP }, () => {
    // 12-try-catch-finally-return: the outer (finally-rethrow) region
    // over-reaches into the catch body, which can throw, so its guard stays.
    const on = js("12-try-catch-finally-return", version);
    assert.match(on, GUARD1);
    assert.match(on, /let __pc = -1;/);
  });

  test(`try-shape changes no control flow at ${version} (annotation-only)`, { skip: SKIP }, () => {
    for (const fixture of ["12-try-catch-finally-return", "13-try-finally-no-catch", "14-nested-try-catch", "15-catch-without-binding", "16-finally-with-break-continue"]) {
      const on = js(fixture, version);
      const off = js(fixture, version, ["try-shape"]);
      for (const [what, re] of [
        ["try clauses", /\btry \{/g],
        ["catch clauses", /\} catch/g],
        ["throws", /\bthrow /g],
        ["functions", /\bfunction \w*\(/g],
        ["loops", /\b(while|for) \(/g],
      ] as const) {
        assert.equal(count(on, re), count(off, re), `${fixture} ${version}: try-shape must not change the number of ${what}`);
      }
    }
  });
}

test("try-shape refuses the dispatch nest of 16-finally-with-break-continue at v94", { skip: SKIP }, () => {
  // Every `try` there has cfgBlock -1: the guard *selects* the handler and is
  // never removable (spec 22 section 4.1 P2).
  const on = js("16-finally-with-break-continue", "v94");
  const off = js("16-finally-with-break-continue", "v94", ["try-shape"]);
  assert.match(on, /__state0/);
  assert.equal(count(on, GUARD), count(off, GUARD), "no guard of a dispatch nest may be removed");
});

// Baseline facts (spec 22 section 2) — run now, and still true after the rung
// lands because `--passes=none` is byte-identical (PL-05).
for (const version of ["v94", "v99"]) {
  test(`baseline (passes=none) emits a range guard per over-reaching region at ${version}`, () => {
    const base = decompile(readFileSync(join(CONSTRUCTS, "12-try-catch-finally-return", `${version}.hbc`)), { resolveV98Ambiguity: true, passes: { none: true } }).code;
    assert.match(base, GUARD1);
    assert.match(base, /__exc = _exc\d+;/);
    assert.ok(count(base, /\} catch/g) >= 2, "fixture 12 has a nested catch and a finally rethrow");
  });
}
