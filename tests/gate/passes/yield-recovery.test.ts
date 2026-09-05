// ACCEPTANCE: spec 25 — docs/specs/passes/25-yield-async-recovery.md, rung
// `yield-recovery` (stage B, generator-shape checker). Written before the
// implementation: every test that needs the rung is `{ skip: SKIP }` and loads
// it through a *non-literal* dynamic import, so this file typechecks and runs
// green while src/passes/yield-recovery/ does not exist. The orchestrator
// lifts the skips in the commit that lands the rung.
//
// Rung-owned properties only: idiom counts, residue counts, refusal evidence
// and the framework premises. No whole-output comparison against a shared
// fixture (CLAUDE.md testing rules / CONSOLIDATION section B item 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import { repoRoot } from "../../support/paths.ts";

const DIR = ["..", "..", "..", "src", "passes", "yield-recovery"].join("/");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function rung(): Promise<{ match: Any; check: Any; yieldRecovery: Any }> {
  const [m, c, i] = await Promise.all([import(`${DIR}/match.ts`), import(`${DIR}/check.ts`), import(`${DIR}/index.ts`)]);
  return { match: (m as Any).match, check: (c as Any).check, yieldRecovery: (i as Any).yieldRecovery };
}

const CONSTRUCTS = join(repoRoot(), "tests", "fixtures", "constructs");
const js = (fixture: string, version: string, skip: readonly string[] = []): string =>
  decompile(readFileSync(join(CONSTRUCTS, fixture, `${version}.hbc`)), { resolveV98Ambiguity: true, passes: skip.length > 0 ? { skip } : {} }).code;
const base = (fixture: string, version: string): string =>
  decompile(readFileSync(join(CONSTRUCTS, fixture, `${version}.hbc`)), { resolveV98Ambiguity: true, passes: { none: true } }).code;
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

// The v<=96 idiom, spec 25 section 1.1/1.2. `MAKE` and `LOWERED` also match the
// helper *definition*, so a site count is the match count minus one.
const MAKE = /__hbc_makeGenerator\(/g;
const LOWERED = /__hbc_makeGeneratorLowered\(/g;
const DISPATCH = /switch \(__state\)/g;
const STATE_INIT = /let __state = 0;/g;
const SUSPEND = /^\s+__state = \d+;$/gm;
const PROTOCOL = /\(__sent, __isReturn, __isThrow\)/g;
const DELEGATED = /__hbc_b_generatorSetDelegated/g;

const OPCODE_ERA = ["v84", "v94", "v96"] as const;
const LOWERED_ERA = ["v98", "v99"] as const;
const GENERATOR_FIXTURES = ["23-generator-basic", "24-generator-return-throw", "25-generator-delegation", "26-infinite-generator-take"] as const;

// ---------------------------------------------------------------------------
// Baseline facts (spec 25 section 1) — true now, and still true after the rung
// lands because `--passes=none` is byte-identical (PL-05).
// ---------------------------------------------------------------------------

for (const version of OPCODE_ERA) {
  test(`baseline: every generator fixture emits the v<=96 shim idiom at ${version}`, () => {
    for (const fixture of GENERATOR_FIXTURES) {
      const s = base(fixture, version);
      assert.ok(count(s, MAKE) >= 2, `${fixture} ${version}: expected at least one __hbc_makeGenerator site`);
      assert.ok(count(s, PROTOCOL) >= 1, `${fixture} ${version}: expected a (__sent, __isReturn, __isThrow) step closure`);
      assert.equal(count(s, STATE_INIT), count(s, PROTOCOL), `${fixture} ${version}: one 'let __state = 0' per step closure`);
      assert.equal(count(s, LOWERED), 0, `${fixture} ${version}: the lowered era must not appear at v<=96`);
    }
  });
}

test("baseline: the v<=96 idiom is absent at v98/v99, where the lowered form appears instead (spec 25 section 1.7)", () => {
  for (const version of LOWERED_ERA) {
    for (const fixture of GENERATOR_FIXTURES) {
      const s = base(fixture, version);
      assert.equal(count(s, MAKE), 0, `${fixture} ${version}`);
      assert.equal(count(s, DISPATCH), 0, `${fixture} ${version}`);
      assert.equal(count(s, PROTOCOL), 0, `${fixture} ${version}`);
      assert.ok(count(s, LOWERED) >= 2, `${fixture} ${version}: expected __hbc_makeGeneratorLowered sites`);
    }
  }
});

test("baseline: measured dispatcher and suspend-site counts (spec 25 section 1.2)", () => {
  // { fixture: [dispatchers, suspend sites] } at every opcode-era version.
  const expected: Record<string, readonly [number, number]> = {
    "23-generator-basic": [2, 5],
    "24-generator-return-throw": [2, 6],
    "25-generator-delegation": [3, 17],
    "26-infinite-generator-take": [2, 2],
    "27-async-await-basic": [1, 3],
    "28-async-await-error": [2, 2],
  };
  for (const version of OPCODE_ERA) {
    for (const [fixture, [dispatchers, suspends]] of Object.entries(expected)) {
      const s = base(fixture, version);
      assert.equal(count(s, DISPATCH), dispatchers, `${fixture} ${version}: dispatchers`);
      assert.equal(count(s, SUSPEND), suspends, `${fixture} ${version}: suspend sites`);
    }
  }
});

// PUSHBACK P-29: as shipped this test compared the *default* pipeline against
// `--passes=none` and called the equality PL-05. It is not PL-05 (which says
// `--passes=none` reproduces the M4 baseline) and it cannot survive this rung:
// rewriting a `__hbc_makeGenerator` site is the rung's entire purpose. The
// property the test was reaching for -- and the one that IS permanent -- is
// that no rung *other* than `yield-recovery` touches the idiom, so the
// comparison is now made with this rung, and only this rung, skipped.
// PUSHBACK P-47: the four tests below were written against the DEFAULT
// pipeline, so the ladder's own follow-up rung `yield-loop`
// (docs/specs/passes/29-yield-loop.md, spec 25 section 6.2) moves them. Every
// assertion is kept verbatim; each is merely scoped to the rung it is about by
// skipping `yield-loop`, so it still measures exactly what `yield-recovery`
// does and nothing else.
const NO_LOOP = ["yield-loop"] as const;
const NO_GEN = ["yield-recovery", "yield-loop"] as const;

test("baseline: the generator idiom is untouched by every rung except the generator rungs", () => {
  for (const version of [...OPCODE_ERA, ...LOWERED_ERA]) {
    for (const fixture of GENERATOR_FIXTURES) {
      const on = js(fixture, version, NO_GEN);
      const off = base(fixture, version);
      for (const [what, re] of [
        ["makeGenerator sites", MAKE],
        ["lowered sites", LOWERED],
        ["dispatchers", DISPATCH],
        ["suspend sites", SUSPEND],
        ["step closures", PROTOCOL],
      ] as const) {
        assert.equal(count(on, re), count(off, re), `${fixture} ${version}: ${what} must not depend on the pass pipeline`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Refusal evidence (spec 25 sections 1.3 and 1.5) — the facts R-Y4 and R-Y6
// exist for. These are counts of a fixture-owned string, not an output
// comparison.
// ---------------------------------------------------------------------------

test("R-Y4 evidence: 24-generator-return-throw duplicates its finally body into the forced-return arms", () => {
  const FINALLY = /g1 finally ran/g;
  for (const version of OPCODE_ERA) {
    assert.equal(count(base("24-generator-return-throw", version), FINALLY), 5, `${version}: the v<=96 lowering duplicates the finally body per suspend point`);
  }
  for (const version of LOWERED_ERA) {
    assert.equal(count(base("24-generator-return-throw", version), FINALLY), 1, `${version}: the lowered era keeps one copy`);
  }
  // The other opcode-era generator fixtures have no such duplication, which is
  // why they are R-Y4-clean.
  for (const fixture of ["23-generator-basic", "26-infinite-generator-take"]) {
    assert.equal(count(base(fixture, "v94"), /finally/g), 0, `${fixture} has no finally to duplicate`);
  }
});

test("R-Y6 evidence: 25-generator-delegation lowers yield* through the __hbc_delegated flag", () => {
  for (const version of OPCODE_ERA) {
    const s = base("25-generator-delegation", version);
    assert.equal(count(s, DELEGATED), 13, `${version}: delegation flag writes`);
    assert.match(s, /var __hbc_delegated = false;/);
    assert.match(s, /if \(__hbc_delegated\) return r\[0\];/);
  }
  // No other generator fixture delegates.
  for (const fixture of ["23-generator-basic", "24-generator-return-throw", "26-infinite-generator-take"]) {
    assert.equal(count(base(fixture, "v94"), DELEGATED), 0, fixture);
  }
});

// ---------------------------------------------------------------------------
// Framework and registration premises (spec 25 sections 1.0, 2, 5).
// ---------------------------------------------------------------------------

// PUSHBACK P-28: as shipped this test asserted the *absence* of every F25-1
// node ("F25-1 would be a duplicate if a yield node already existed"). That is
// a pre-condition, true exactly once -- F25-1 is a required framework item of
// the same spec (section 2), and neither rung can be built without it, so the
// assertion could not survive the landing it was written for. Re-pointed at the
// landed state: the same four facts, asserted positively. The `sameFrame`
// assertion -- section 1.0's actual stage-B evidence, and the anchor both
// matchers key on -- is carried over verbatim.
test("F25-1: src/emit/ast.ts declares the yield/await nodes and the generator/async flags, and still carries sameFrame", () => {
  const ast = readFileSync(join(repoRoot(), "src", "emit", "ast.ts"), "utf8");
  assert.match(ast, /k: "yield"/, "F25-1 adds the yield node");
  assert.match(ast, /k: "await"/, "F25-1 adds the await node");
  assert.match(ast, /readonly generator\?/, "F25-1 adds the generator flag to the func node");
  assert.match(ast, /readonly async\?/, "F25-1 adds the async flag to the func node");
  // Section 1.0's third stage-B argument: the step closure is a first-class
  // stage-B AST node with a dedicated marker, and stays one.
  assert.match(ast, /readonly sameFrame\?: true;/);
});

test("PL-06 premise: catalogue row 17 is verified and points at spec 25", () => {
  const cat = readFileSync(join(repoRoot(), "docs", "LOWERING-CATALOGUE.md"), "utf8");
  const row = cat.split("\n").find((l) => l.startsWith("| 17 |"));
  assert.ok(row, "catalogue row 17 must exist");
  assert.match(row, /✅/);
  assert.match(row, /spec 25/i);
});

test("spec 25 section 1.8: the committed rn-template bundle is v94 and DOES contain the generator idiom", () => {
  const bytes = readFileSync(join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc"));
  const s = decompile(bytes, { passes: { none: true } }).code;
  assert.match(s, /HBC version 94/);
  // 7 sites + the helper definition; 6 dispatchers (one generator has no yield).
  assert.equal(count(s, MAKE), 8);
  assert.equal(count(s, STATE_INIT), 7);
  assert.equal(count(s, DISPATCH), 6);
  assert.equal(count(s, LOWERED), 0);
  // Consequence, section 6.1: unlike class-recover, this rung WILL move the
  // pinned rn-template hash in tests/gate/passes/pipeline-speed.test.ts.
  // Regenerating that hash is Fred's call; this test records why it is needed.
});

// ---------------------------------------------------------------------------
// Skipped until the rung exists (spec 25 section 5).
// ---------------------------------------------------------------------------

test("yield-recovery is a stage-B rung on catalogue row 17, in the structure block before renaming", async () => {
  const { yieldRecovery } = await rung();
  assert.equal(yieldRecovery.stage, "B");
  assert.deepEqual([...(yieldRecovery.catalogue as (number | string)[])], [17]);
  assert.ok((yieldRecovery.before as string[]).includes("fn-naming"));
  assert.ok((yieldRecovery.before as string[]).includes("var-naming"));
  const { REGISTRY, enabledPasses } = (await import(["..", "..", "..", "src", "passes", "registry.ts"].join("/"))) as Any;
  const names = (REGISTRY as { name: string }[]).map((p) => p.name);
  assert.ok(names.includes("yield-recovery"));
  assert.ok(names.indexOf("yield-recovery") < names.indexOf("fn-naming"));
  assert.doesNotThrow(() => enabledPasses({}));
});

test("yield-recovery's versions predicate accepts 84/94/96 and rejects 98/99", async () => {
  const { yieldRecovery } = await rung();
  const v = yieldRecovery.versions as (n: number, layout: string) => boolean;
  for (const n of [84, 94, 96]) assert.equal(v(n, "C"), true, `v${n}`);
  for (const n of [98, 99]) assert.equal(v(n, "E"), false, `v${n}`);
});

test("yield-recovery: a body with no generator group is a fixed point without consulting the context (PL-08)", async () => {
  const { match } = await rung();
  assert.equal(match([{ k: "return", arg: null }] as Any, {} as Any), null);
});

test("yield-recovery recovers 23-generator-basic's acyclic `sequence` and leaves the cyclic `counter` alone", () => {
  for (const version of OPCODE_ERA) {
    const on = js("23-generator-basic", version, NO_LOOP);
    const off = js("23-generator-basic", version, NO_GEN);
    assert.equal(count(on, MAKE), count(off, MAKE) - 1, `${version}: exactly one of the two sites is recovered`);
    assert.ok(count(on, /function\* /g) >= 1, `${version}: a real generator function is emitted`);
    assert.equal(count(on, /\byield /g), 4, `${version}: sequence has four yields`);
    assert.equal(count(on, DISPATCH), count(off, DISPATCH) - 1, `${version}: counter's dispatcher survives (R-Y5)`);
  }
});

test("yield-recovery refuses 24-generator-return-throw's g1 with R-Y4 (finally body in the forced-return arm)", () => {
  const on = js("24-generator-return-throw", "v94");
  assert.match(on, /g1 finally ran/, "the finally body must survive verbatim when the group is refused");
  assert.equal(count(on, /g1 finally ran/g), 5, "no copy may be dropped");
});

test("docs/specs/passes/25-yield-async-recovery.md §5: g1's R-Y4 refusal surfaces as a W_PASS_REFUSED diagnostic, not silently", () => {
  const r = decompile(readFileSync(join(CONSTRUCTS, "24-generator-return-throw", "v94.hbc")), { resolveV98Ambiguity: true });
  const refused = r.diagnostics.filter((d) => d.code === "W_PASS_REFUSED" && (d.context as { pass?: string }).pass === "yield-recovery");
  assert.ok(refused.length > 0, "yield-recovery must report at least one refusal for this fixture");
  assert.ok(
    refused.some((d) => (d.context as { reason?: string }).reason === "forced-return-body"),
    `expected a forced-return-body (R-Y4) refusal among ${JSON.stringify(refused.map((d) => d.context))}`,
  );
  for (const d of refused) assert.ok((d.context as { count?: number }).count! >= 1, "a reported refusal must count at least one site");
});

// PUSHBACK P-32: the spec (section 1.5) says "fixture 25 is refused in full, at
// every version", and this test asserted it as an equality of
// `__hbc_makeGenerator` counts. Measured, that is false: the fixture's `inner`
// is a plain three-suspend acyclic generator with no `yield*` and no back edge
// -- structurally the same group as `23`'s `sequence` -- so neither R-Y6 nor
// R-Y5 has anything to fire on, and refusing it would need a rule that does
// not exist. The R-Y6 property the test is named for is asserted directly
// instead, and more tightly: every group that *does* delegate stays a shim.
test("yield-recovery refuses 25-generator-delegation's delegating groups with R-Y6 at every opcode-era version", () => {
  for (const version of OPCODE_ERA) {
    const on = js("25-generator-delegation", version, NO_LOOP);
    const off = js("25-generator-delegation", version, NO_GEN);
    // `inner` (no delegation, acyclic) is the one group R-Y6 does not claim.
    assert.equal(count(on, MAKE), count(off, MAKE) - 1, `${version}: only the non-delegating group is rewritten`);
    assert.match(on, /function\* inner\(/, `${version}`);
    for (const delegating of ["outer", "delegatesToArray"]) {
      assert.match(on, new RegExp(`\\n\\s*function ${delegating}\\(`), `${version}: ${delegating} delegates, so it stays a shim (R-Y6)`);
      assert.doesNotMatch(on, new RegExp(`function\\* ${delegating}\\(`), `${version}: ${delegating} must not be recovered`);
    }
    assert.equal(count(on, DELEGATED), 13, version);
  }
});

test("yield-recovery refuses 26-infinite-generator-take with R-Y5 (cyclic suspend graph)", () => {
  for (const version of OPCODE_ERA) {
    const on = js("26-infinite-generator-take", version, NO_LOOP);
    const off = js("26-infinite-generator-take", version, NO_GEN);
    assert.equal(count(on, DISPATCH), count(off, DISPATCH), `${version}: the cyclic dispatcher survives`);
  }
});

test("yield-recovery leaves no protocol residue in a group it recovered", () => {
  const on = js("23-generator-basic", "v94");
  const fn = on.slice(on.indexOf("function* sequence"), on.indexOf("counter"));
  for (const residue of [/__state/, /__done/, /__sent/, /__isReturn/, /__isThrow/, /__this\b/, /__args\b/]) {
    assert.doesNotMatch(fn, residue, `${residue} must not survive in a recovered generator (R-Y8 / section 3.4 obligation 5)`);
  }
});

test("yield-recovery's checker rejects an `after` whose yield order differs from the suspend order", async () => {
  const { check } = await rung();
  const before = { k: "func", name: "g", params: [], body: [] };
  const after = { k: "func", name: "g", params: [], body: [], generator: true };
  const result = check(before as Any, after as Any, { applied: [] } as Any) as { ok: boolean; reason?: string };
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /order|suspend|yield/i);
});
