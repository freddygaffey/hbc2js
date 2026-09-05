// ACCEPTANCE: docs/BUGS.md 2026-09-01 row "class private fields" (bucket
// `diff:GetOwnPrivateBySym/GetByVal`) -- rung `private-fields` (stage B),
// docs/specs/passes/24-class-recover.md's private-name follow-up.
//
// T2 equivalence (tests/gate/decompile/equivalence.test.ts) found this rung's
// first landing UNSAFE: `AddOwnPrivateBySym`'s install always runs inside the
// constructor, and every constructor this codebase decompiles (base or
// derived) builds a *separate* plain object via `Object.create(new.target
// .prototype)` and explicitly `return`s it -- the real `this` is never
// referenced at all (fixtures 32-36 all share this shape; see
// tests/gate/passes/class-recover.test.ts's own fixtures). A native
// `#name = v;` field write only succeeds on an object that received the
// class's private-field brand during ITS OWN [[Construct]] -- i.e. on the
// real `this`, never on a same-shaped stand-in object -- so folding the
// install into a class-field declaration silently changes behaviour:
// `r1.#balance = v` throws `TypeError: Cannot write private member #balance
// to an object whose class did not declare it`, which is exactly what the
// T2 harness caught (trace diverges at record 0, the `new BankAccount(...)`
// call). `match.ts`'s `isThisArg` now requires the install's own target to
// resolve to literal `this`; since no committed fixture's constructor ever
// touches `this`, this rung currently refuses on all of them -- proven safe
// (refusal, not silent breakage) rather than proven positive on a real
// fixture. The positive path (an install that *does* target `this`) is
// covered by a hand-built AST case below, the same way the escape refusal
// already was.
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
  test(`private-fields: ${version} refuses fixture 35 (its constructor's install target is not literal 'this') -- output matches --passes=none's Symbol form`, () => {
    const on = js(version);
    const none = js(version, "none");
    // Same shape as --passes=none for the private-name block specifically:
    // no rung is unsafe enough to fold it, so the Symbol/computed-member
    // form survives every stage-B rung, same as the fully-disabled baseline.
    assert.match(on, /Symbol\("#balance"\)/);
    assert.match(on, /Symbol\("#history"\)/);
    assert.doesNotMatch(on, /#balance\s*=/);
    assert.doesNotMatch(on, /\.#balance\b/);
    assert.doesNotMatch(on, /#balance in \w+/);
    // Not byte-identical to --passes=none (other rungs, e.g. class-recover
    // itself, still run) -- only the private-name shape is asserted equal.
    assert.equal(on.includes('Symbol("#balance")'), none.includes('Symbol("#balance")'));
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
