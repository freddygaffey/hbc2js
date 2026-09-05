// ACCEPTANCE: spec 24 -- docs/specs/passes/24-class-recover.md, rung
// `class-recover` (stage B). Written before the implementation: every test
// that needs the rung is `{ skip: SKIP }` and loads it through a *non-literal*
// dynamic import, so this file typechecks and runs green while
// src/passes/class-recover/ does not exist. The orchestrator lifts the skips
// in the commit that lands the rung.
//
// Rung-owned properties only: class-creation site counts, member-install
// descriptor shapes, the refusal negatives (spec 24 section 4 R-C1/R-C6), the
// version reach of spec 24 section 1.0 and the catalogue row PL-06 needs. No
// whole-output comparison against a shared fixture (CLAUDE.md testing rules /
// CONSOLIDATION section B item 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import { parseCatalogueIndex } from "../../../src/passes/catalogue.ts";
import { repoRoot } from "../../support/paths.ts";

// Sub-forms C1/C3/C4 were skipped until F24-5 (PUSHBACK P-38, docs/BUGS.md row
// `class-recover-orphan-methods`): the emitter placed a method or constructor
// closure that captures nothing at MODULE level, not inside the function whose
// `CreateClosure` made it, so for fixtures 32, 34 and 36 the declarations the
// class body must hold were not in `ctx.fnBody` and the rung refused
// (`ctor-not-in-body` / `method-not-in-body`). F24-5 places such a function in
// the single function that creates it, and the three tests below run unchanged.
const DIR = ["..", "..", "..", "src", "passes", "class-recover"].join("/");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function rung(): Promise<{ match: Any; check: Any; classRecover: Any }> {
  const [m, c, i] = await Promise.all([import(`${DIR}/match.ts`), import(`${DIR}/check.ts`), import(`${DIR}/index.ts`)]);
  return { match: (m as Any).match, check: (c as Any).check, classRecover: (i as Any).classRecover };
}

const CONSTRUCTS = join(repoRoot(), "tests", "fixtures", "constructs");
const js = (fixture: string, version: string, mode: "on" | "off" | "none" = "on"): string =>
  decompile(readFileSync(join(CONSTRUCTS, fixture, `${version}.hbc`)), {
    resolveV98Ambiguity: true,
    passes: mode === "none" ? { none: true } : mode === "off" ? { skip: ["class-recover"] } : {},
  }).code;
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
/** Strips the two `// hbc2js -- decompiled from vNN.hbc` header lines, which
 *  are the only thing that legitimately differs between two versions. */
const bodyOf = (s: string): string => s.split("\n").slice(2).join("\n");

// Every class fixture (spec 24 section 1.0). All five have BOTH a v98 and a
// v99 build committed, contrary to their own versions.txt (PUSHBACK P-22).
const FIXTURES = ["32-class-basic", "33-class-inheritance-super", "34-class-static-members", "35-class-private-fields", "36-class-getters-setters"];
const CLASS_VERSIONS = ["v98", "v99"];
// A class method/accessor install: non-enumerable, configurable (spec 24
// section 1.1). The object-literal accessors of section 1.5 are `enumerable:
// true` and must never be counted as class members.
const MEMBER_INSTALL = /Object\.defineProperty\([^\n]*enumerable: false, configurable: true\}\)/g;
const ENUMERABLE_INSTALL = /Object\.defineProperty\([^\n]*enumerable: true, configurable: true\}\)/g;
const SET_PROTO = /Object\.setPrototypeOf\(/g;

// ---------------------------------------------------------------------------
// Baseline facts (spec 24 section 1). True today; still true after the rung
// lands, because `--passes=none` is byte-identical for ever (PL-05).
// ---------------------------------------------------------------------------

test("spec 24 section 1.0: every class fixture builds at v98 AND v99 with the same lowered shape", () => {
  // The ladder row says "99 only; <=98 shape unmeasured" and each fixture's
  // versions.txt says "Only v99.hbc exists in this directory". Both are stale:
  // this is the measurement behind PUSHBACK P-22 and behind upgrading
  // catalogue row 20 to a cross-version "verified".
  for (const fixture of FIXTURES) {
    const v98 = bodyOf(js(fixture, "v98", "none"));
    const v99 = bodyOf(js(fixture, "v99", "none"));
    assert.ok(v98.length > 0, `${fixture}: v98.hbc must decompile`);
    assert.equal(v98.split("\n").length, v99.split("\n").length, `${fixture}: same statement count at both versions`);
    for (const [what, re] of [
      ["member installs", MEMBER_INSTALL],
      ["enumerable installs", ENUMERABLE_INSTALL],
      ["prototype links", SET_PROTO],
      ["defineProperty calls", /Object\.defineProperty\(/g],
      ["new.target reads", /new\.target/g],
    ] as const) {
      assert.equal(count(v98, re), count(v99, re), `${fixture}: ${what} must not differ between v98 and v99`);
    }
  }
});

test("spec 24 section 1.0: 32/33/34 are byte-identical at v98 and v99; 35 and 36 differ only as documented", () => {
  for (const fixture of ["32-class-basic", "33-class-inheritance-super", "34-class-static-members"]) {
    assert.equal(bodyOf(js(fixture, "v98", "none")), bodyOf(js(fixture, "v99", "none")), `${fixture}`);
  }
  // 36: the ONLY difference is the accessor functions' bytecode names -- v99
  // prefixes the accessor role into the function-table name, v98 does not. The
  // caveat behind F24-4: the descriptor is the authority, the name a
  // cross-check.
  const a = bodyOf(js("36-class-getters-setters", "v98", "none")).split("\n");
  const b = bodyOf(js("36-class-getters-setters", "v99", "none")).split("\n");
  const differing = a.map((l, i) => [l, b[i] ?? ""] as const).filter(([x, y]) => x !== y);
  assert.equal(differing.length, 3, "36 must differ at exactly the three accessor-name comments");
  for (const [x, y] of differing) {
    assert.match(x, /\/\/ fn#\d+ "(area|width)"/);
    assert.match(y, /\/\/ fn#\d+ "(get|set) (area|width)"/);
  }
  // 35: identical shape, different register allocation between the two pins.
  const c = bodyOf(js("35-class-private-fields", "v98", "none"));
  const d = bodyOf(js("35-class-private-fields", "v99", "none"));
  assert.notEqual(c, d, "35's two pins allocate registers differently");
  assert.equal(count(c, /Symbol\("#/g), count(d, /Symbol\("#/g));
});

test("baseline (passes=none): no class fixture prints a `class` today -- the whole point of the rung", () => {
  for (const fixture of FIXTURES) {
    for (const version of CLASS_VERSIONS) {
      assert.doesNotMatch(js(fixture, version, "none"), /(^|\s)class\s+[A-Za-z_$]/, `${fixture} ${version}`);
    }
  }
});

test("baseline: the base form installs methods as non-enumerable prototype properties (spec 24 section 1.1)", () => {
  for (const version of CLASS_VERSIONS) {
    const base = js("32-class-basic", version, "none");
    assert.equal(count(base, MEMBER_INSTALL), 3, `${version}: 32-class-basic has three prototype methods`);
    // Keys are register reads at `--passes=none` (the name literal is a
    // separate store); the default pipeline folds them back to literals.
    for (const name of ["distanceFromOrigin", "toString", "translate"]) {
      assert.match(base, new RegExp(`"${name}"`), `${version}: ${name} is a string constant of the module`);
    }
    // The constructor value is a bare closure reference and the prototype is
    // read off it -- the two CreateBaseClass destinations (src/emit/lower.ts).
    assert.match(base, /= \w+\.prototype;/);
  }
});

test("baseline: the derived form is a pair of Object.setPrototypeOf calls (spec 24 section 1.2)", () => {
  for (const version of CLASS_VERSIONS) {
    const base = js("33-class-inheritance-super", version, "none");
    // Two derived classes (Dog extends Animal, Puppy extends Dog), two calls
    // each: the constructor link and the prototype link.
    assert.equal(count(base, SET_PROTO), 4, `${version}: 33 has two CreateDerivedClass sites`);
    assert.match(base, /Object\.setPrototypeOf\(\w+, \w+ === null \? null : \w+\.prototype\)/, `${version}: the prototype link's null guard`);
    // `super` is NOT owned by this rung (R-C8): these shapes must survive.
    assert.match(base, /getPrototypeOf/, `${version}: super.method() stays a prototype walk`);
  }
});

test("baseline: a get/set pair arrives as two separate installs (spec 24 section 1.3)", () => {
  for (const version of CLASS_VERSIONS) {
    const base = js("36-class-getters-setters", version, "none");
    assert.match(base, /Object\.defineProperty\(\w+, \w+, \{get: \w+, enumerable: false, configurable: true\}\)/, `${version}: accessor get half`);
    assert.match(base, /Object\.defineProperty\(\w+, \w+, \{set: \w+, enumerable: false, configurable: true\}\)/, `${version}: accessor set half`);
  }
});

test("baseline negative R-C1: fixture 36's object-literal accessors are enumerable and have no class provenance", () => {
  for (const version of CLASS_VERSIONS) {
    const base = js("36-class-getters-setters", version, "none");
    assert.equal(count(base, ENUMERABLE_INSTALL), 2, `${version}: the plain-object accessors (celsius, fahrenheit)`);
    assert.match(base, /\{get: \w+, set: \w+, enumerable: true, configurable: true\}/, `${version}: one descriptor carrying both halves`);
    assert.match(base, /"celsius"/, `${version}`);
  }
});

test("baseline negative R-C6: fixture 35 lowers private fields to Symbols installed on the instance", () => {
  for (const version of CLASS_VERSIONS) {
    const base = js("35-class-private-fields", version, "none");
    assert.match(base, /Symbol\("#balance"\)/, `${version}`);
    assert.match(base, /writable: true, enumerable: false, configurable: false/, `${version}: an instance install, not a class-body member`);
  }
});

test("spec 24 section 1.8: the committed rn-template bundle is v94, so it has no class opcode and no golden hash to move", () => {
  // Cheap and exact: the HBC header is an 8-byte magic followed by a uint32
  // version field. Class lowering does not exist below v98 (every fixture's
  // versions.txt), so a v96 bundle cannot contain CreateBaseClass at all --
  // which is why this rung must not change tests/gate/passes/pipeline-speed's
  // pinned output hash.
  const bytes = readFileSync(join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc"));
  const version = bytes.readUInt32LE(8);
  assert.equal(version, 94, `rn-template bundle version, saw ${version}`);
  assert.ok(version < 98, "a bundle below v98 cannot carry CreateBaseClass/CreateDerivedClass");
});

test("F24-1 has landed: src/emit/ast.ts declares the class node the rung writes into", () => {
  // Written as the premise "there is nowhere to put a recovered class", whose
  // own comment says "if this ever fails, F24-1 has landed": it has, in this
  // commit, so the premise becomes the postcondition. Both node kinds are
  // required -- the `class` expression the rung emits, and the `classdecl`
  // statement the AST owes the language (PUSHBACK P-37).
  const ast = readFileSync(join(repoRoot(), "src", "emit", "ast.ts"), "utf8");
  assert.match(ast, /k: "class"/);
  assert.match(ast, /k: "classdecl"/);
});

test("PL-06: catalogue row 20 exists and is verified", () => {
  // The same parser checkCatalogue uses, so this test fails for exactly the
  // reasons registration would (only the status cell counts, not the notes).
  const rows = parseCatalogueIndex(readFileSync(join(repoRoot(), "docs", "LOWERING-CATALOGUE.md"), "utf8"));
  const row = rows.get(20);
  assert.ok(row !== undefined, "docs/LOWERING-CATALOGUE.md has no row 20 for classes");
  assert.match(row.idiom, /class/i, `row 20 must be the classes row, is: ${row.idiom}`);
  assert.ok(row.status.includes("✅") && !/single-version/i.test(row.status), `row 20 status must be verified, is: ${row.status}`);
});

// ---------------------------------------------------------------------------
// Rung shape and ordering (spec 24 section 2).
// ---------------------------------------------------------------------------

test("class-recover is a stage-B structure rung on catalogue row 20, before the naming rungs (P-21)", {}, async () => {
  const { classRecover } = await rung();
  assert.equal(classRecover.stage, "B");
  assert.deepEqual([...(classRecover.catalogue as (number | string)[])], [20]);
  for (const dep of ["expr-rebuild", "call-shape", "object-literal"]) assert.ok((classRecover.after as string[]).includes(dep), `missing after: ${dep}`);
  // D23: a structure-recovery rung runs while every register still carries its
  // bytecode identity, i.e. before fn-naming/reg-split/var-naming. This is the
  // ordering PUSHBACK P-21 raises against the ladder row's `after: [fn-naming]`.
  for (const dep of ["fn-naming", "reg-split", "var-naming"]) assert.ok((classRecover.before as string[]).includes(dep), `missing before: ${dep}`);
  const { REGISTRY, enabledPasses } = (await import(["..", "..", "..", "src", "passes", "registry.ts"].join("/"))) as Any;
  const names = (REGISTRY as { name: string }[]).map((p) => p.name);
  assert.ok(names.indexOf("class-recover") < names.indexOf("fn-naming"));
  assert.doesNotThrow(() => enabledPasses({}));
});

test("class-recover restricts itself to the versions it was measured at: 98 and 99, layout E (spec 24 section 2)", {}, async () => {
  const { classRecover } = await rung();
  const ok = classRecover.versions as (v: number, layout: string) => boolean;
  assert.ok(typeof ok === "function", "F7: the rung must declare a versions predicate");
  for (const v of [84, 94, 96]) assert.equal(ok(v, "E"), false, `v${v} has no class lowering in hermesc at all`);
  for (const v of [98, 99]) assert.equal(ok(v, "E"), true, `v${v} was measured (spec 24 section 1.0)`);
});

test("class-recover: a body with no class-creation site is a fixed point (R-C0/PL-08)", {}, async () => {
  const { match } = await rung();
  const body = [{ k: "expr", expr: { k: "call", callee: { k: "member", obj: { k: "ident", name: "Object" }, prop: { k: "ident", name: "defineProperty" }, computed: false }, args: [] } }];
  assert.equal(match(body as Any, { fnBody: body } as Any), null);
});

// ---------------------------------------------------------------------------
// Fixture properties (spec 24 section 5).
// ---------------------------------------------------------------------------

test("class-recover recovers the base form and consumes every owned install", {}, () => {
  for (const version of CLASS_VERSIONS) {
    const on = js("32-class-basic", version);
    const off = js("32-class-basic", version, "off");
    assert.equal(count(on, /(^|\s)class\s+Point\b/g), 1, `${version}: one class head named from the bytecode function name`);
    assert.equal(count(on, MEMBER_INSTALL), 0, `${version}: every owned defineProperty is consumed`);
    assert.equal(count(off, MEMBER_INSTALL), 3, `${version}: control`);
    // The method bodies are moved, not rebuilt: the same number of function
    // bodies exist before and after (three methods + constructor + global).
    assert.equal(count(on, /\breturn /g), count(off, /\breturn /g), `${version}: no return is added or lost`);
  }
});

test("class-recover recovers `extends` from the setPrototypeOf pair", {}, () => {
  for (const version of CLASS_VERSIONS) {
    const on = js("33-class-inheritance-super", version);
    assert.equal(count(on, /(^|\s)class\s+\w+\s+extends\s+\w+/g), 2, `${version}: Dog extends Animal, Puppy extends Dog`);
    assert.equal(count(on, SET_PROTO), 0, `${version}: both links are consumed by the class head`);
    // R-C8: super is still not raised, and must survive untouched.
    assert.match(on, /Reflect\.get\(/, `${version}`);
  }
});

test("class-recover merges a split get/set pair into two accessor members", {}, () => {
  for (const version of CLASS_VERSIONS) {
    const on = js("36-class-getters-setters", version);
    assert.match(on, /get area\(\)/, `${version}`);
    assert.match(on, /get width\(\)/, `${version}`);
    assert.match(on, /set width\(/, `${version}`);
  }
});

test("class-recover refuses the object-literal accessors and the private-field installs (R-C1, R-C6)", {}, () => {
  for (const version of CLASS_VERSIONS) {
    // R-C1: fixture 36's enumerable accessors have no class provenance.
    assert.equal(count(js("36-class-getters-setters", version), ENUMERABLE_INSTALL), 2, `${version}: R-C1`);
    // R-C6: class-recover itself never folds a Symbol-keyed instance install
    // into a class member (it is not a method/getter/setter descriptor
    // shape) -- observed with the `private-fields` follow-up rung (spec 24's
    // private-name recovery, docs/BUGS.md 2026-09-01 "class private fields",
    // PUSHBACK P-40) switched off, since *that* rung, not class-recover, is
    // what folds this shape into real `#name` syntax under the default
    // pipeline (see tests/gate/passes/private-fields.test.ts).
    const on = decompile(readFileSync(join(CONSTRUCTS, "35-class-private-fields", `${version}.hbc`)), { resolveV98Ambiguity: true, passes: { skip: ["private-fields"] } }).code;
    assert.match(on, /Symbol\("#balance"\)/, `${version}: R-C6`);
    assert.match(on, /writable: true, enumerable: false, configurable: false/, `${version}: R-C6`);
  }
});

test("class-recover puts statics on the class object, never the prototype (R-C10, needs F24-3)", {}, () => {
  // Fixture 34's CreateBaseClass aliases dst_ctor and dst_prototype
  // (`CreateBaseClass r2, r2, r1, 1`), and src/emit/lower.ts clobbers the
  // constructor with `<ctor>.prototype`, so today every static lands on the
  // prototype (docs/BUGS.md 2026-09-05 `class-ctor-proto-alias`). Until F24-3
  // lands the rung refuses the site; once it does, this is the shape.
  for (const version of CLASS_VERSIONS) {
    const on = js("34-class-static-members", version);
    assert.match(on, /static generate\(\)/, `${version}`);
    assert.match(on, /static reset\(\)/, `${version}`);
    assert.doesNotMatch(on, /\.prototype\.generate\b/, `${version}: a static must not be installed on the prototype`);
  }
});

test("class-recover's checker rejects an `after` whose member order differs from the install order", {}, async () => {
  const { check } = await rung();
  const method = (name: string) => ({ kind: "method", static: false, computed: false, key: { k: "lit", text: `"${name}"` }, value: { k: "func", name: "", params: [], body: [] } });
  const before = [{ k: "expr", expr: { k: "lit", text: "0" } }];
  const forged = [{ k: "classdecl", name: "C", value: { k: "class", name: "C", superClass: null, members: [method("b"), method("a")] } }];
  const r = check(before as Any, forged as Any, { fnBody: before } as Any);
  assert.equal(r.ok, false, "a member order the installs never produced must be refused");
});

// ---------------------------------------------------------------------------
// F24-5 regressions. Both failed before F24-5 and pass after it.

test("F24-5: the class-shape checker finds the rewritten head in the rebuilt body (off-by-one)", () => {
  // `check` substitutes the new head's effects for the old head's at
  // `rebuilt[headPos]`. `headPos` was the *count* of deletions preceding the
  // head, which is its index in `rebuilt` only when `headIndex` happens to be
  // twice that count. 32-class-basic (four moved declarations, head at index 7)
  // is the first fixture where it is not: the substitution read the `rN =
  // <ctor>.prototype` alias store that follows the head, counted that store
  // twice, and abandoned the whole group with "changed the effect sequence".
  for (const version of CLASS_VERSIONS) {
    const r = decompile(readFileSync(join(CONSTRUCTS, "32-class-basic", `${version}.hbc`)), { resolveV98Ambiguity: true });
    const abandoned = r.diagnostics.filter((d) => d.code === "W_PASS_ABANDONED" && d.message.includes("class-recover"));
    assert.deepEqual(
      abandoned.map((d) => d.message),
      [],
      `${version}: class-recover must not abandon its only site`,
    );
  }
});

test("F24-5: a class method or constructor that captures nothing is declared in the function that creates it", () => {
  // The precondition the rung needs, asserted on the emitter alone
  // (`--passes=none`): no `// orphan` comment, and every method/constructor
  // body nested inside `_fn0` rather than sitting at module level.
  for (const fixture of ["32-class-basic", "34-class-static-members", "36-class-getters-setters"]) {
    for (const version of CLASS_VERSIONS) {
      const out = js(fixture, version, "none");
      assert.doesNotMatch(out, /\/\/ orphan:/, `${fixture} ${version}: nothing is an orphan any more`);
      const lines = out.split("\n");
      const global = lines.findIndex((l) => /^\s*function _fn0\(\)/.test(l));
      assert.ok(global >= 0, `${fixture} ${version}: the global function is emitted`);
      const decls = lines.map((l, i) => [l, i] as const).filter(([l]) => /^\s*function _fn[1-9]\d*\(/.test(l));
      assert.ok(decls.length >= 2, `${fixture} ${version}: the class's own functions are emitted as declarations`);
      for (const [line, i] of decls) {
        assert.ok(i > global, `${fixture} ${version}: ${line.trim()} must come after fn#0's own header, i.e. inside it`);
        assert.ok(/^ {4,}function/.test(line), `${fixture} ${version}: ${line.trim()} must be nested, not at module level`);
      }
    }
  }
});
