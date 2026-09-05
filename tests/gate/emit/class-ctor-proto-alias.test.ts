// F24-3 regression: docs/BUGS.md (2026-09-05 `class-ctor-proto-alias`),
// docs/specs/passes/24-class-recover.md section 1.4/6.6. hermesc aliases
// dst_ctor and dst_prototype to the same register on
// CreateBaseClass/CreateBaseClassLongIndex and
// CreateDerivedClass/CreateDerivedClassLongIndex whenever a class has no
// instance members needing the prototype register kept alive, and (per
// Interpreter-slowpaths.cpp's caseCreateClass, MIT-licensed Hermes source)
// the interpreter writes the prototype value first and the constructor value
// *last*, so an aliased register ends up holding the constructor. Before this
// fix, src/emit/lower.ts's second `set()` unconditionally overwrote the
// register with `<ctor>.prototype`, clobbering the constructor.
//
// Rung-owned properties only (CLAUDE.md testing rules): regexes on the
// decompiled output's shape, not a literal-string comparison against the
// whole output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import { repoRoot } from "../../support/paths.ts";

const CONSTRUCTS = join(repoRoot(), "tests", "fixtures", "constructs");
// The property under test is the EMITTER's. Since F24-5 these two fixtures'
// constructors and methods are declared inside fn#0 instead of at module level,
// so two stage-B rungs now reach them: `class-recover` folds the very statements
// these regexes read (the `<ident> = _fn1` binding, the `Object.setPrototypeOf`
// pair, the static installs) into a `class` head, and `fn-naming` renames `_fn1`
// to its bytecode name. Skipping exactly those two keeps every assertion below
// as written, measuring exactly what it was written to measure (`--passes=none`
// would not: the descriptor keys are still registers before `expr-rebuild`). The
// recovered shape is asserted by tests/gate/passes/class-recover.test.ts.
const js = (fixture: string, version: string): string =>
  decompile(readFileSync(join(CONSTRUCTS, fixture, `${version}.hbc`)), { resolveV98Ambiguity: true, passes: { skip: ["class-recover", "fn-naming"] } }).code;

test("CreateBaseClass: an aliased dst_ctor/dst_prototype installs statics on the constructor, not the prototype (34-class-static-members)", () => {
  for (const version of ["v98", "v99"]) {
    const out = js("34-class-static-members", version);
    // The constructor binding (whatever it is named) must receive both the
    // static installs and the later static reads/calls -- it must NOT be
    // reassigned to its own `.prototype` partway through.
    const ctor = /(\w+)\s*=\s*_fn1;/.exec(out);
    assert.ok(ctor, `${version}: expected a bare "<ident> = _fn1;" constructor binding\n${out}`);
    const name = ctor![1];
    assert.doesNotMatch(out, new RegExp(`${name}\\s*=\\s*${name}\\.prototype`), `${version}: the constructor must never be clobbered with its own .prototype`);
    assert.match(out, new RegExp(`Object\\.defineProperty\\(${name}, "generate"`), `${version}: "generate" must install onto the constructor binding`);
    assert.match(out, new RegExp(`${name}\\.generate\\(\\)`), `${version}: the later call must read "generate" off the same constructor binding`);
  }
});

test("CreateDerivedClass: an aliased dst_ctor/dst_prototype still sets the real prototype's proto chain and installs statics on the constructor (67-class-static-and-new)", () => {
  for (const version of ["v98", "v99"]) {
    const out = js("67-class-static-and-new", version);
    // Sub's static "tag" must land on the derived constructor (Sub2/whatever
    // it is renamed to), never on `<ctor>.prototype`.
    assert.doesNotMatch(out, /\.prototype,\s*\{value:\s*\w+,\s*enumerable:\s*false,\s*configurable:\s*true\}\)/, `${version}: no static install descriptor may target a bare .prototype expression`);
    // The two setPrototypeOf calls that encode `extends` must still run, the
    // second one addressing the real prototype object via `<ctor>.prototype`
    // read lazily (the aliased register itself holds the constructor).
    assert.match(out, /Object\.setPrototypeOf\(\w+2?,\s*\w+\)/, `${version}: expected the constructor-chain setPrototypeOf`);
    assert.match(out, /Object\.setPrototypeOf\(\w+\.prototype,/, `${version}: expected the prototype-chain setPrototypeOf to address <ctor>.prototype directly`);
  }
});
