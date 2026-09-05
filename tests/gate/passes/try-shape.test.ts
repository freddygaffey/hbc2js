// ACCEPTANCE: spec 22 — docs/specs/passes/22-try-shape-try-clean.md, rung
// `try-shape` (stage A, annotation-only). Landed 2026-09-05 (skips lifted;
// two fixture-level tests corrected against measured behaviour, PUSHBACK
// P-18 in docs/PUSHBACK.md). Still loaded through a *non-literal* dynamic
// import for consistency with the rest of the file's history.
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

test("try-shape is a stage-A rung on catalogue row 11, ordered before label-clean", async () => {
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

test("try-shape: an already-annotated try is a fixed point without consulting the context (P0/PL-08)", async () => {
  const { match } = await rung();
  const node = { k: "try", region: 0, cfgBlock: 3, body: { k: "block", cfgBlock: 3 }, handler: { k: "block", cfgBlock: 4 }, catchRegister: 6, shape: { bindsExc: true, guard: "needed" } };
  assert.equal(match(node as Any, {} as Any), null);
});

// ---------------------------------------------------------------------------
// Fixture properties (spec 22 section 7).
// ---------------------------------------------------------------------------

for (const version of ["v94", "v99"]) {
  test(`try-shape drops the redundant range guard in 15-catch-without-binding at ${version}`, () => {
    const on = js("15-catch-without-binding", version);
    const off = js("15-catch-without-binding", version, ["try-shape"]);
    // The over-reaching block of `tryParse`'s region is the `return` block:
    // it cannot throw, so the guard is provably always true (spec 22 4.1).
    assert.ok(count(on, GUARD) < count(off, GUARD), `expected fewer guards with try-shape on (${count(on, GUARD)} vs ${count(off, GUARD)})`);
    const fn = on.slice(on.indexOf(String.raw`"tryParse"`), on.indexOf("function unreliable"));
    assert.doesNotMatch(fn, GUARD1);
    // With no guard left in the function, the emitter needs no __pc at all.
    assert.doesNotMatch(fn, PC_STORE1);
    // The handler never reads the catch register, so the binding goes too.
    assert.match(fn, /\} catch \{/);
  });

  test(`try-shape keeps the guard whose over-reaching block can throw at ${version}`, () => {
    // 13-try-finally-no-catch's `cleanup` function: the finally-rethrow
    // region's body is just `log.push('body')` (region.bodyBlocks), but the
    // try's lexical extent over-reaches into the block that prints
    // `log.push('cleanup')` — a real call, which can throw, so the guard
    // stays (spec 22 §4.1; PUSHBACK P-18 corrects this test's fixture: the
    // spec's own worked example, fixture 12, measures as *redundant* at
    // both versions — its only over-reaching block is a bare `return` of a
    // literal, which `canThrow` correctly refuses to treat as risky).
    const on = js("13-try-finally-no-catch", version);
    // v99 leaves this function as `_fn2` (orphan: no closure-creation site
    // to recover its declared name from), so anchor on the `// fn#… "name"`
    // comment fn-naming always prints instead of the (possibly unrenamed)
    // declaration keyword.
    const start = on.indexOf('"cleanup"');
    const fn = on.slice(start, start + 400);
    assert.match(fn, GUARD1);
    assert.match(on, /let __pc = -1;/);
  });

  test(`try-shape drops both provably-redundant guards in 12-try-catch-finally-return at ${version} (PUSHBACK P-18)`, () => {
    // Measured (this worktree, 2026-09-05): fn#2 "f2" has two exception
    // regions. The outer's over-reach is a lone `return 'finally-wins'`
    // block (LoadConstString/Ret only — neither can throw); the inner has
    // no over-reach at all. Neither guard is ever consulted, so both
    // disappear and `f2` ends up with no `__pc` scaffolding whatsoever.
    const on = js("12-try-catch-finally-return", version);
    const off = js("12-try-catch-finally-return", version, ["try-shape"]);
    assert.ok(count(on, GUARD) < count(off, GUARD), `expected fewer guards with try-shape on (${count(on, GUARD)} vs ${count(off, GUARD)})`);
    const fn = on.slice(on.indexOf("function f2"), on.indexOf("function f3"));
    assert.doesNotMatch(fn, GUARD1);
    assert.doesNotMatch(fn, PC_STORE1);
  });

  test(`try-shape changes no structural control flow at ${version} (annotation-only)`, () => {
    // "structural": try/catch clauses, functions and loops — never added,
    // removed or duplicated by an annotation-only rewrite (`blocksMultiset`
    // equality, 00-LADDER §4.3). `throw` is deliberately excluded: F22-2
    // means a provably-redundant guard's own synthetic `throw _excN` simply
    // is not printed once try-shape has annotated it — that is the rung's
    // entire purpose, demonstrated by 12 and 15 above (PUSHBACK P-18).
    for (const fixture of ["12-try-catch-finally-return", "13-try-finally-no-catch", "14-nested-try-catch", "15-catch-without-binding", "16-finally-with-break-continue"]) {
      const on = js(fixture, version);
      const off = js(fixture, version, ["try-shape"]);
      for (const [what, re] of [
        ["try clauses", /\btry \{/g],
        ["catch clauses", /\} catch/g],
        ["functions", /\bfunction \w*\(/g],
        ["loops", /\b(while|for) \(/g],
      ] as const) {
        assert.equal(count(on, re), count(off, re), `${fixture} ${version}: try-shape must not change the number of ${what}`);
      }
    }
  });
}

test("try-shape refuses the dispatch nest of 16-finally-with-break-continue at v94", () => {
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
