// docs/BUGS.md 2026-09-01 (Service NSW whole-file abort) + 2026-09-04
// (react-navigation `_e2326_0`) — EM-01's module-level scope check used to be
// all-or-nothing: the FIRST unbound identifier anywhere in a 15,000-function
// module threw `E_UNBOUND_IDENT` out of `emitModule`, so one bad nested
// function cost the whole file's output. `collectUnbound` reports every
// unbound identifier with the chain of emitted function *statements* it sits
// under, which is what lets `emitModule` isolate exactly those functions
// (`W_UNBOUND_ISOLATED`, a throwing stub body) and still emit the module.
// The throwing `checkBindings` is unchanged and still runs afterwards, so a
// non-per-function scope bug is still a hard failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hbc2jsError, ErrorCode } from "../../../src/errors.ts";
import { checkBindings, collectUnbound, unboundMessage } from "../../../src/emit/scope-check.ts";
import { id, lit, p } from "../../../src/emit/ast.ts";
import type { Stmt } from "../../../src/emit/ast.ts";

/** `_fn0` (the global function) with one nested function that reads an env
 *  slot nobody declares, and one that is fine. */
function program(): Stmt[] {
  const bad: Stmt = { k: "func", name: "_fn7", params: [p("a1")], body: [{ k: "return", arg: id("_e99_0") }] };
  const good: Stmt = { k: "func", name: "_fn8", params: [], body: [{ k: "decl", kind: "let", names: ["r0"] }, { k: "return", arg: id("r0") }] };
  const outer: Stmt = { k: "func", name: "_fn3", params: [], body: [bad, good, { k: "return", arg: id("_fn7") }] };
  return [{ k: "iife", body: [{ k: "func", name: "_fn0", params: [], body: [outer, { k: "return", arg: id("_fn3") }] }, { k: "return", arg: id("_fn0") }] }];
}

test("collectUnbound reports the unbound name with its function-statement path", () => {
  const found = collectUnbound(program(), [], 0);
  assert.deepEqual(
    found.map((u) => ({ name: u.name, path: u.path.join(" > ") })),
    [{ name: "_e99_0", path: "module > _fn0 > _fn3 > _fn7" }],
  );
  assert.match(unboundMessage(found[0]!), /"_e99_0" is not declared in any enclosing scope \(module > _fn0 > _fn3 > _fn7\)/);
});

test("collectUnbound reports every offender, not just the first, and each once", () => {
  const two: Stmt[] = [
    { k: "func", name: "_fn1", params: [], body: [{ k: "expr", expr: id("_e1_0") }, { k: "expr", expr: id("_e1_0") }] },
    { k: "func", name: "_fn2", params: [], body: [{ k: "expr", expr: id("_e2_0") }] },
  ];
  const found = collectUnbound(two, [], 0);
  assert.deepEqual(found.map((u) => `${u.path.join(">")}|${u.name}`), ["module>_fn1|_e1_0", "module>_fn2|_e2_0"]);
});

test("a well-scoped program has no unbound identifiers and checkBindings accepts it", () => {
  const ok: Stmt[] = [{ k: "func", name: "_fn0", params: [], body: [{ k: "decl", kind: "let", names: ["_e1_0"] }, { k: "expr", expr: id("_e1_0") }] }];
  assert.deepEqual(collectUnbound(ok, [], 0), []);
  checkBindings(ok, [], 0);
});

test("checkBindings still throws E_UNBOUND_IDENT on the first offender", () => {
  assert.throws(
    () => {
      checkBindings(program(), [], 0);
    },
    (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_UNBOUND_IDENT && /_e99_0/.test(e.message),
  );
});

test("a stub body (comment + throw new Error) never trips the scope check", () => {
  const stubbed: Stmt[] = [
    {
      k: "func",
      name: "_fn7",
      params: [p("a1")],
      body: [
        { k: "comment", text: "_fn7 -- ISOLATED FAILURE (E_UNBOUND_IDENT)" },
        { k: "throw", arg: { k: "new", callee: id("Error"), args: [lit('"hbc2js: could not decompile _fn7 -- E_UNBOUND_IDENT"')] } },
      ],
    },
  ];
  assert.deepEqual(collectUnbound(stubbed, [], 0), []);
});
