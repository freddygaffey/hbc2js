// ACCEPTANCE: rung `ctor-this` (stage B, readability row R12) --
// docs/specs/passes/26-ctor-this.md.
//
// Hermes gives a base-class constructor its own receiver: `GetNewTarget` +
// `GetById "prototype"` + `NewObjectWithParent`, kept in a register and
// returned. That register IS what the language binds to `this` on entry to a
// base [[Construct]], so the rung deletes the allocation and substitutes
// `this`. The reason it matters beyond readability is `private-fields`: a
// native `#name` can only brand the object the class's own [[Construct]]
// created, so nothing folded while the constructor addressed a stand-in
// (docs/BUGS.md 2026-09-01 "class private fields", reopened 2026-09-05).
//
// Rung-owned properties only (CLAUDE.md testing rules / CONSOLIDATION section
// B item 7): no whole-output string comparison against a shared fixture. The
// end-to-end proof that the substitution is behaviour-preserving is T2
// (tests/gate/decompile/equivalence.test.ts) at v99, not this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import { repoRoot } from "../../support/paths.ts";
import { foldAll, foldCtorBody } from "../../../src/passes/ctor-this/match.ts";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const js = (fixture: string, version: "v98" | "v99", mode: "on" | "none" = "on"): string =>
  decompile(new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", fixture, `${version}.hbc`))), {
    resolveV98Ambiguity: true,
    passes: mode === "none" ? { none: true } : {},
  }).code;

/** Every fixture whose class-recover output is a BASE class with the
 *  `NewObjectWithParent` stand-in. 32-class-basic is deliberately absent: its
 *  constructor uses the seeded `Object.assign(Object.create(...), {...})`
 *  allocation, refusal R-CT2 (asserted below). */
const BASE_FIXTURES = ["34-class-static-members", "35-class-private-fields", "36-class-getters-setters"] as const;

for (const fixture of BASE_FIXTURES) {
  for (const version of ["v98", "v99"] as const) {
    test(`ctor-this: ${fixture} ${version} -- the recovered base-class constructor allocates no stand-in`, () => {
      const on = js(fixture, version);
      assert.doesNotMatch(on, /new\.target\.prototype/);
      assert.doesNotMatch(on, /Object\.create\(/);
      assert.match(on, /\bclass \w+ \{/);
      // ...and `--passes=none` still shows the untouched lowering (PL-05).
      // The baseline has not run `expr-rebuild` either, so the member read
      // is still its own statement: `rN = new.target; rN = rN.prototype;`.
      const none = js(fixture, version, "none");
      assert.match(none, /new\.target/);
      assert.match(none, /Object\.create\(/);
    });
  }
}

test("ctor-this: 32-class-basic keeps its seeded allocation (refusal R-CT2, both versions)", () => {
  for (const version of ["v98", "v99"] as const) {
    const on = js("32-class-basic", version);
    assert.match(on, /Object\.assign\(Object\.create\(new\.target\.prototype\)/);
  }
});

test("ctor-this: 33-class-inheritance-super's derived constructor is untouched (refusal R-CT1)", () => {
  for (const version of ["v98", "v99"] as const) {
    const on = js("33-class-inheritance-super", version);
    // The derived class still takes its receiver from the super call.
    assert.match(on, /class \w+ extends /);
    assert.match(on, /Reflect\.construct\(/);
  }
});

// --- hand-built shapes: one positive, three refusals, one fixed point -------

const NEW_TARGET_PROTO: Any = { k: "member", obj: { k: "lit", text: "new.target" }, prop: { k: "lit", text: "prototype" }, computed: false };
const allocation = (reg: string): Any => ({
  k: "call",
  callee: { k: "member", obj: { k: "ident", name: "Object" }, prop: { k: "lit", text: "create" }, computed: false },
  args: [
    {
      k: "cond",
      test: { k: "bin", op: "===", left: { k: "ident", name: reg }, right: { k: "lit", text: "null" } },
      then: { k: "lit", text: "null" },
      else: {
        k: "cond",
        test: { k: "bin", op: "===", left: { k: "unary", op: "typeof ", arg: { k: "ident", name: reg } }, right: { k: "lit", text: '"object"' } },
        then: { k: "ident", name: reg },
        else: { k: "member", obj: { k: "ident", name: "Object" }, prop: { k: "lit", text: "prototype" }, computed: false },
      },
    },
  ],
});
const standIn = (reg: string): Any[] => [
  { k: "init", kind: "let", name: reg, value: NEW_TARGET_PROTO },
  { k: "expr", expr: { k: "assign", target: { k: "ident", name: reg }, value: allocation(reg) } },
];
const classWith = (body: Any[], superClass: Any = null): Any => ({
  k: "class",
  name: "C",
  superClass,
  members: [{ kind: "method", static: false, computed: false, key: { k: "ident", name: "constructor" }, value: { k: "func", name: null, params: [], body } }],
});
const ctorOf = (cls: Any): Any[] => cls.members[0].value.body;

test("ctor-this: folds the stand-in and drops the trailing `return this`", () => {
  const cls = classWith([...standIn("r1"), { k: "expr", expr: { k: "assign", target: { k: "member", obj: { k: "ident", name: "r1" }, prop: { k: "lit", text: "x" }, computed: false }, value: { k: "lit", text: "1" } } }, { k: "return", arg: { k: "ident", name: "r1" } }]);
  const before: Any[] = [{ k: "init", kind: "let", name: "r7", value: cls }];
  const { folded, after } = foldAll(before);
  assert.deepEqual(folded, ["C"]);
  const body = ctorOf((after[0] as Any).value);
  assert.equal(body.length, 1, "only the property store survives");
  assert.equal(body[0].expr.target.obj.k, "this");
  // PL-08: a second run is a no-op.
  assert.deepEqual(foldAll(after).folded, []);
});

test("ctor-this: refuses a derived class (R-CT1)", () => {
  const cls = classWith([...standIn("r1"), { k: "return", arg: { k: "ident", name: "r1" } }], { k: "ident", name: "Base" });
  const outcome = foldCtorBody(cls, ctorOf(cls)) as Any;
  assert.equal(outcome.code, "R-CT1");
});

test("ctor-this: refuses a constructor that never returns the stand-in (R-CT4)", () => {
  const cls = classWith([...standIn("r1"), { k: "expr", expr: { k: "call", callee: { k: "ident", name: "sink" }, args: [{ k: "ident", name: "r1" }] } }]);
  const outcome = foldCtorBody(cls, ctorOf(cls)) as Any;
  assert.equal(outcome.code, "R-CT4");
  assert.deepEqual(foldAll([{ k: "init", kind: "let", name: "r7", value: cls } as Any]).folded, []);
});

test("ctor-this: refuses a constructor that returns something else on one path (R-CT4)", () => {
  const cls = classWith([...standIn("r1"), { k: "if", test: { k: "ident", name: "a1" }, then: [{ k: "return", arg: { k: "lit", text: "null" } }], else: [] }, { k: "return", arg: { k: "ident", name: "r1" } }]);
  const outcome = foldCtorBody(cls, ctorOf(cls)) as Any;
  assert.equal(outcome.code, "R-CT4");
});

test("ctor-this: refuses a stand-in register that is written again (R-CT3)", () => {
  const cls = classWith([...standIn("r1"), { k: "expr", expr: { k: "assign", target: { k: "ident", name: "r1" }, value: { k: "ident", name: "other" } } }, { k: "return", arg: { k: "ident", name: "r1" } }]);
  const outcome = foldCtorBody(cls, ctorOf(cls)) as Any;
  assert.equal(outcome.code, "R-CT3");
});

test("ctor-this: refuses when the stand-in name also occurs inside a nested closure (R-CT5)", () => {
  const closure: Any = { k: "func", name: null, params: [], body: [{ k: "return", arg: { k: "ident", name: "r1" } }] };
  const cls = classWith([...standIn("r1"), { k: "expr", expr: { k: "call", callee: { k: "ident", name: "sink" }, args: [closure] } }, { k: "return", arg: { k: "ident", name: "r1" } }]);
  const outcome = foldCtorBody(cls, ctorOf(cls)) as Any;
  assert.equal(outcome.code, "R-CT5");
});

test("ctor-this: refuses a stand-in holder that is not declared in the constructor body (R-CT0)", () => {
  const cls = classWith([
    { k: "expr", expr: { k: "assign", target: { k: "ident", name: "outer" }, value: NEW_TARGET_PROTO } },
    { k: "expr", expr: { k: "assign", target: { k: "ident", name: "outer" }, value: allocation("outer") } },
    { k: "return", arg: { k: "ident", name: "outer" } },
  ]);
  const outcome = foldCtorBody(cls, ctorOf(cls)) as Any;
  assert.equal(outcome.code, "R-CT0");
});
