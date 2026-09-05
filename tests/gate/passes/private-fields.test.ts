// ACCEPTANCE: docs/BUGS.md 2026-09-01 row "class private fields" (bucket
// `diff:GetOwnPrivateBySym/GetByVal`) -- rung `private-fields` (stage B),
// docs/specs/passes/24-class-recover.md's private-name follow-up.
//
// History, because it is the whole reason this file's fixture case reads the
// way it does. T2 equivalence (tests/gate/decompile/equivalence.test.ts)
// found this rung's first landing UNSAFE: `AddOwnPrivateBySym`'s install
// always runs inside the constructor, and every constructor this codebase
// decompiled at the time built a *separate* plain object via
// `Object.create(new.target.prototype)` and explicitly `return`ed it -- the
// real `this` was never referenced at all. A native `#name = v;` field write
// only succeeds on an object that received the class's private-field brand
// during ITS OWN [[Construct]], so folding the install into a class-field
// declaration there silently changed behaviour: `r1.#balance = v` throws
// `TypeError: Cannot write private member #balance to an object whose class
// did not declare it` (trace diverged at record 0, the `new BankAccount(...)`
// call). `match.ts`'s `isThisArg` therefore requires the install's own target
// to resolve to literal `this`, and the rung refused everywhere.
//
// The `ctor-this` rung (docs/specs/passes/26-ctor-this.md, landed 2026-09-05)
// removes the stand-in: in a recovered BASE class it proves the allocated
// object IS the receiver the language binds to `this` and substitutes it. So
// `isThisArg` now holds on fixture 35 and this rung folds it for real -- the
// fixture case below asserts the `#name` syntax, and T2 at v99 is what proves
// it runs. The hand-built refusal cases stay exactly as they were: the
// `isThisArg` guard is unchanged, it is its *input* that changed.
//
// Rung-owned properties only (CLAUDE.md testing rules / CONSOLIDATION section
// B item 7). No whole-output string comparison against the shared fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import { repoRoot } from "../../support/paths.ts";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const FIXTURE = join(repoRoot(), "tests", "fixtures", "constructs", "35-class-private-fields");
const js = (version: "v98" | "v99", mode: "on" | "none" = "on"): string =>
  decompile(new Uint8Array(readFileSync(join(FIXTURE, `${version}.hbc`))), {
    resolveV98Ambiguity: true,
    passes: mode === "none" ? { none: true } : {},
  }).code;

for (const version of ["v98", "v99"] as const) {
  test(`private-fields: ${version} folds fixture 35's #balance/#history into real private syntax (ctor-this made the install target literal 'this')`, () => {
    const on = js(version);
    // The two instance fields fold: a real declaration in the class body and
    // real `.#name` accesses in the methods that read them.
    assert.match(on, /#balance/);
    assert.match(on, /\.#balance\b/);
    assert.match(on, /\.#history\b/);
    // ...and the symbol-keyed lowering of those two names is gone.
    assert.doesNotMatch(on, /Symbol\("#balance"\)/);
    assert.doesNotMatch(on, /Symbol\("#history"\)/);
    // The private *method* `#record` and its `PrivateIsIn` brand check are
    // not folded by this rung (it owns field declarations and field
    // accesses only); the class brand symbol survives as a Symbol, which is
    // exactly the shape the checker's "no new free name" obligation allows.
    assert.match(on, /Symbol\("BankAccount"\)/);
    // Regression (this landing): dropping an alias store in its `k:"init"`
    // spelling must not take the register's declaration with it while a
    // later statement still assigns it -- `withdraw`'s `r0` is reassigned to
    // `globalThis` on the throwing arm, and an undeclared assignment inside
    // a class body (always strict) is a ReferenceError.
    for (const m of on.matchAll(/^\s*(\w+) = globalThis;$/gm)) {
      const name = m[1]!;
      assert.match(on, new RegExp(`let (\\w+, )*${name}\\b`), `${name} is assigned but never declared`);
    }
  });
}

test("private-fields: --passes=none reproduces the M4 baseline (PL-05)", () => {
  for (const version of ["v98", "v99"] as const) {
    const code = js(version, "none");
    assert.match(code, /Symbol\("#balance"\)/);
    assert.doesNotMatch(code, /\.#balance\b/);
  }
});

// Hand-built AST cases, same style as class-recover's own unit tests: they
// exercise `foldAll` directly so the *positive* path (a genuinely safe
// install, one that targets literal `this`) has coverage even though no
// committed fixture's constructor shape can reach it today.
const sym = (n: string) => ({ k: "call", callee: { k: "ident", name: "Symbol" }, args: [{ k: "lit", text: `"${n}"` }] });
const install = (obj: Any, key: string, value: Any) => ({
  k: "expr",
  expr: { k: "call", callee: { k: "member", obj: { k: "ident", name: "Object" }, prop: { k: "lit", text: "defineProperty" }, computed: false }, args: [obj, { k: "ident", name: key }, { k: "object", props: [{ key: "value", computed: false, value }, { key: "writable", computed: false, value: { k: "lit", text: "true" } }, { key: "enumerable", computed: false, value: { k: "lit", text: "false" } }, { key: "configurable", computed: false, value: { k: "lit", text: "false" } }] }] },
});
const THIS: Any = { k: "this" };

test("private-fields: folds a private field whose install targets literal `this` (the one safe shape)", async () => {
  const { foldAll } = (await import("../../../src/passes/private-fields/match.ts")) as Any;
  const ctor = {
    k: "func",
    name: null,
    params: [],
    body: [install(THIS, "_e0_0", { k: "ident", name: "undefined" }), { k: "return", arg: THIS }],
  };
  const reader = {
    k: "func",
    name: null,
    params: [],
    body: [{ k: "return", arg: { k: "member", obj: THIS, prop: { k: "ident", name: "_e0_0" }, computed: true } }],
  };
  const cls = {
    k: "class",
    name: "C",
    superClass: null,
    members: [
      { kind: "method", static: false, computed: false, key: { k: "ident", name: "constructor" }, value: ctor },
      { kind: "method", static: false, computed: false, key: { k: "lit", text: "read" }, value: reader },
    ],
  };
  const before = [{ k: "expr", expr: { k: "assign", target: { k: "ident", name: "_e0_0" }, value: sym("#x") } }, { k: "init", kind: "let", name: "r7", value: cls }];
  const { folded, after } = foldAll(before);
  assert.deepEqual(folded, ["#x"]);
  const printed = JSON.stringify(after);
  assert.ok(printed.includes('"kind":"field"') && printed.includes('"text":"#x"'), "expected a #x field member");
  assert.ok(!printed.includes("Symbol"), "the Symbol( declaration should be gone");
});

test("private-fields: refuses when the install targets something other than `this` (a stand-in object, class-recover's own constructor shape)", async () => {
  const { foldAll } = (await import("../../../src/passes/private-fields/match.ts")) as Any;
  const ctor = {
    k: "func",
    name: null,
    params: [],
    body: [install({ k: "ident", name: "r1" }, "_e0_0", { k: "ident", name: "undefined" }), { k: "return", arg: { k: "ident", name: "r1" } }],
  };
  const cls = {
    k: "class",
    name: "C",
    superClass: null,
    members: [{ kind: "method", static: false, computed: false, key: { k: "ident", name: "constructor" }, value: ctor }],
  };
  const before = [{ k: "expr", expr: { k: "assign", target: { k: "ident", name: "_e0_0" }, value: sym("#x") } }, { k: "init", kind: "let", name: "r7", value: cls }];
  const { folded, after } = foldAll(before);
  assert.deepEqual(folded, []);
  assert.equal(after, before);
});

test("private-fields: refuses a private name that escapes its class (stored outside the recognised shapes)", async () => {
  const { foldAll } = (await import("../../../src/passes/private-fields/match.ts")) as Any;
  const ctor = {
    k: "func",
    name: null,
    params: [],
    body: [install(THIS, "_e0_0", { k: "ident", name: "undefined" }), { k: "return", arg: THIS }],
  };
  const leaky = {
    k: "func",
    name: null,
    params: [],
    body: [{ k: "expr", expr: { k: "call", callee: { k: "ident", name: "leak" }, args: [{ k: "ident", name: "_e0_0" }] } }],
  };
  const cls = {
    k: "class",
    name: "C",
    superClass: null,
    members: [
      { kind: "method", static: false, computed: false, key: { k: "ident", name: "constructor" }, value: ctor },
      { kind: "method", static: false, computed: false, key: { k: "lit", text: "leaky" }, value: leaky },
    ],
  };
  const before = [{ k: "expr", expr: { k: "assign", target: { k: "ident", name: "_e0_0" }, value: sym("#x") } }, { k: "init", kind: "let", name: "r7", value: cls }];
  const { folded, after } = foldAll(before);
  assert.deepEqual(folded, []);
  assert.equal(after, before);
});
