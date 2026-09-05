// ACCEPTANCE: spec 23 -- docs/specs/passes/23-arguments-form-literal-forms.md,
// rung `literal-forms` (stage B, sub-forms L-R regex and L-T TypeOfIs masks;
// L-B BigInt is a documented no-op, PUSHBACK P-18). Written before the
// implementation: every test that needs the rung is `{ skip: SKIP }` and loads
// it through a *non-literal* dynamic import, so this file typechecks and runs
// green while src/passes/literal-forms/ does not exist. The orchestrator lifts
// the skips in the commit that lands the rung.
//
// Rung-owned properties only: literal counts, the mask bit table, the escaping
// round trip, the no-op fixtures. No whole-output comparison against a shared
// fixture (CLAUDE.md testing rules / CONSOLIDATION section B item 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import { parseCatalogueIndex } from "../../../src/passes/catalogue.ts";
import { getTypeOfIsTable } from "../../../src/tables/registry.ts";
import type { OpcodeTableId } from "../../../src/tables/types.ts";
import { repoRoot } from "../../support/paths.ts";

const DIR = ["..", "..", "..", "src", "passes", "literal-forms"].join("/");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function rung(): Promise<{ match: Any; check: Any; literalForms: Any }> {
  const [m, c, i] = await Promise.all([import(`${DIR}/match.ts`), import(`${DIR}/check.ts`), import(`${DIR}/index.ts`)]);
  return { match: (m as Any).match, check: (c as Any).check, literalForms: (i as Any).literalForms };
}

const CONSTRUCTS = join(repoRoot(), "tests", "fixtures", "constructs");
const js = (fixture: string, version: string, mode: "on" | "off" | "none" = "on"): string =>
  decompile(readFileSync(join(CONSTRUCTS, fixture, `${version}.hbc`)), {
    resolveV98Ambiguity: true,
    passes: mode === "none" ? { none: true } : mode === "off" ? { skip: ["literal-forms"] } : {},
  }).code;
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
const NEW_REGEXP = /new RegExp\(/g;
const NEGATED_TYPEOF = /!\(typeof /g;
const OBJECT_NULL = /=== "object" && \w+ !== null \|\| \w+ === null/g;
// 45/46/55 have no v84 build (named groups, BigInt literals, TypeOfIs).
const VERSIONS = ["v94", "v96", "v98", "v99"];
const TYPEOF_IS_VERSIONS = ["v98", "v99"];

// ---------------------------------------------------------------------------
// Baseline facts (spec 23 sections 1.2-1.4). True today; still true after the
// rung lands, because `--passes=none` is byte-identical for ever (PL-05).
// ---------------------------------------------------------------------------

test("baseline (passes=none): every regex literal is a `new RegExp(pattern, flags)` call at every version", () => {
  for (const version of VERSIONS) {
    const base = js("45-regex-literals", version, "none");
    assert.equal(count(base, NEW_REGEXP), 6, `${version}: 45-regex-literals has 6 CreateRegExp sites`);
    assert.match(base, /new RegExp\("\\\\b\\\\w\+\\\\b", "g"\)/);
    // The unflagged literal still passes an explicit empty flags string.
    assert.match(base, /new RegExp\(",", ""\)/);
  }
});

test("baseline (passes=none): the TypeOfIs mask expansion appears only from v98 on", () => {
  for (const version of VERSIONS) {
    const base = js("55-typeof-is-masks", version, "none");
    const expected = TYPEOF_IS_VERSIONS.includes(version);
    // Complement masks (507, 383, 503) print as `!(typeof x === "s")`, and the
    // Object|Null pair (258) as the two-test disjunction. Below v98 there is no
    // TypeOfIs opcode and the emitter already prints the source shape.
    assert.equal(count(base, NEGATED_TYPEOF) > 0, expected, `${version}: negated-typeof expansion presence`);
    assert.equal(count(base, OBJECT_NULL) > 0, expected, `${version}: Object|Null disjunction presence`);
    if (!expected) {
      // Below v98 the source shape survives into the default pipeline's output
      // (expr-rebuild has to fold the compare back together first, so this is
      // asserted on the default pipeline, not on the raw baseline). It is the
      // shape L-T has to reproduce at v98/v99, and the rung must leave it be.
      const folded = js("55-typeof-is-masks", version);
      assert.match(folded, /typeof \w+ !== "string"/);
      assert.match(folded, /typeof \w+ === "object"/);
    }
  }
});

test("the escaping rule of spec 23 section 4.2 round-trips every pattern in 45-regex-literals", () => {
  // L-R builds the literal body from `new RegExp(pattern, flags).source`, the
  // ES EscapeRegExpPattern result, which is defined to be re-parsable as a
  // literal with the same behaviour. The refusal R-L4 is this check failing.
  const base = js("45-regex-literals", "v94", "none");
  const sites = [...base.matchAll(/new RegExp\((".*?"), (".*?")\)/g)];
  assert.equal(sites.length, 6, "expected all six sites to have two string-literal arguments");
  for (const [, rawPattern, rawFlags] of sites) {
    const pattern = JSON.parse(rawPattern as string) as string;
    const flags = JSON.parse(rawFlags as string) as string;
    const original = new RegExp(pattern, flags);
    const body = original.source;
    assert.doesNotMatch(body, /[\n\r\u2028\u2029]/, "R-L5: a literal body may not contain a raw line terminator");
    assert.ok(!body.startsWith("*"), "R-L5: a literal body may not open a comment");
    const reparsed = new RegExp(body, flags);
    assert.equal(reparsed.source, original.source, `round trip changed the source of /${body}/${flags}`);
    assert.equal(reparsed.flags, original.flags);
  }
  // The empty pattern is the case that would print `//` -- `.source` already
  // answers `(?:)` for it, which is why L-R needs no special case.
  assert.equal(new RegExp("", "g").source, "(?:)");
  // And an unescaped `/` in the pattern text comes back escaped (the RN
  // template's `new RegExp("\\/", "g")` shape, docs/lowering/regex-literals.md).
  assert.equal(new RegExp("a/b").source, "a\\/b");
});

test("the TypeOfIsTypes bit table of spec 23 section 1.4 matches the generated Hermes tables", () => {
  const expected = ["Undefined", "Object", "String", "Symbol", "Boolean", "Number", "Bigint", "Function", "Null"];
  for (const id of ["hbc98-late", "hbc99-feb2026", "hbc99-mar2026"] as OpcodeTableId[]) {
    const table = getTypeOfIsTable(id);
    assert.ok(table !== null && table !== undefined, `no TypeOfIsTypes table for pin ${id}`);
    assert.deepEqual([...table.types], expected, `${id}: bit order`);
  }
  const bit = (name: string): number => 1 << expected.indexOf(name);
  const full = (1 << expected.length) - 1;
  assert.equal(full, 511);
  // Every mask measured in 55-typeof-is-masks at v98 and v99.
  assert.equal(bit("String"), 4);
  assert.equal(full - bit("String"), 507);
  assert.equal(full - bit("Function"), 383);
  assert.equal(full - bit("Symbol"), 503);
  assert.equal(bit("Object") | bit("Null"), 258);
  assert.equal(full - (bit("Object") | bit("Null")), 253);
});

test("PUSHBACK P-18: BigInt table constants are already literals, with or without passes", () => {
  for (const version of VERSIONS) {
    for (const mode of ["none", "on"] as const) {
      const code = js("46-bigint-arithmetic", version, mode);
      assert.match(code, /9007199254740993n/, `${version} ${mode}: BigInt table constant must print as a literal`);
      assert.doesNotMatch(code, /BigInt\("/, "no string-argument BigInt() reconstruction");
    }
  }
});

test("PL-06: catalogue rows 29 and 30 exist and are verified", () => {
  const rows = parseCatalogueIndex(readFileSync(join(repoRoot(), "docs", "LOWERING-CATALOGUE.md"), "utf8"));
  for (const [n, idiom] of [
    [29, "CreateRegExp"],
    [30, "TypeOfIs"],
  ] as const) {
    const row = rows.get(n);
    assert.ok(row !== undefined, `docs/LOWERING-CATALOGUE.md has no row ${n}`);
    assert.ok(row.idiom.includes(idiom), `row ${n} must be the ${idiom} row, is: ${row.idiom}`);
    assert.ok(row.status.includes("✅") && !/single-version/i.test(row.status), `row ${n} status must be verified, is: ${row.status}`);
  }
});

// ---------------------------------------------------------------------------
// Rung shape and ordering (spec 23 section 2).
// ---------------------------------------------------------------------------

test("literal-forms is a stage-B rung on catalogue rows 29 and 30, before the naming rungs", async () => {
  const { literalForms } = await rung();
  assert.equal(literalForms.stage, "B");
  assert.deepEqual([...(literalForms.catalogue as (number | string)[])], [29, 30]);
  for (const dep of ["fn-naming", "reg-split", "var-naming"]) assert.ok((literalForms.before as string[]).includes(dep), `missing before: ${dep}`);
  const { REGISTRY, enabledPasses } = (await import(["..", "..", "..", "src", "passes", "registry.ts"].join("/"))) as Any;
  const names = (REGISTRY as { name: string }[]).map((p) => p.name);
  assert.ok(names.includes("literal-forms"));
  assert.ok(names.indexOf("literal-forms") < names.indexOf("var-naming"));
  assert.doesNotThrow(() => enabledPasses({}));
});

test("literal-forms: an already-raised expression is a fixed point (PL-08)", async () => {
  const { match } = await rung();
  assert.equal(match({ k: "regex", pattern: "a", flags: "g" } as Any, {} as Any), null);
  assert.equal(match({ k: "bin", op: "!==", left: { k: "unary", op: "typeof ", arg: { k: "ident", name: "r1" } }, right: { k: "lit", text: '"string"' } } as Any, {} as Any), null);
});

// ---------------------------------------------------------------------------
// Fixture properties (spec 23 section 5).
// ---------------------------------------------------------------------------

test("L-R: every regex-table site becomes a literal, at every version", () => {
  for (const version of VERSIONS) {
    const on = js("45-regex-literals", version);
    assert.equal(count(on, NEW_REGEXP), 0, `${version}: no CreateRegExp site may stay a constructor call`);
    assert.match(on, /\/\\b\\w\+\\b\/g/);
    assert.match(on, /\/\^\[a-z\]\+\$\/i/);
    // The unflagged literal loses the empty flags string, not the slashes.
    assert.match(on, /\/,\//);
    // The emitter prints a `// fn#N "name"` comment (always `// ` with a
    // trailing space) at the top of the module and of every function, so a
    // blanket `//` search is unsatisfiable against any real output; an
    // empty-pattern regex literal prints as `//<flags>` instead, i.e. `//`
    // immediately followed by a non-space, which distinguishes the two.
    assert.doesNotMatch(on, /\/\/\S/, "an empty pattern must print as /(?:)/, never //");
  }
});

test("L-R refuses a `new RegExp` with no regex-table provenance (R-L1)", async () => {
  const { match } = await rung();
  const node = { k: "new", callee: { k: "ident", name: "RegExp" }, args: [{ k: "lit", text: '"a"' }, { k: "lit", text: '"g"' }] };
  assert.equal(match(node as Any, {} as Any), null, "without fromRegExpTable the global read is real and must survive");
});

test("L-T: v98/v99 print the same typeof shapes v94/v96 already print", () => {
  for (const version of TYPEOF_IS_VERSIONS) {
    const on = js("55-typeof-is-masks", version);
    assert.equal(count(on, NEGATED_TYPEOF), 0, `${version}: no negated-typeof expansion may survive`);
    assert.equal(count(on, OBJECT_NULL), 0, `${version}: no Object|Null disjunction may survive`);
    assert.match(on, /typeof \w+ !== "string"/);
    assert.match(on, /typeof \w+ !== "function"/);
    assert.match(on, /typeof \w+ === "object"/);
    // A single-bit mask was already in its clearest form and is not touched.
    assert.match(on, /typeof \w+ === "number"/);
  }
});

test("L-T is a no-op where the typeof is not a mask expansion (R-T2/R-T3)", () => {
  for (const version of VERSIONS) {
    for (const fixture of ["47-typeof-instanceof-in", "46-bigint-arithmetic"]) {
      assert.equal(js(fixture, version), js(fixture, version, "off"), `${fixture} ${version}: literal-forms must rewrite nothing here`);
    }
  }
});
