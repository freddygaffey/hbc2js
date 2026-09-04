// Regression test for the hardened-tier class divergences of 2026-09-05
// (docs/BUGS.md): the generated hbc99-mar2026 builtin table was missing
// `HermesBuiltin.setFunctionName`, so builtin 55 was named
// `functionPrototypeApply` and every computed method/accessor name in a v99
// module decompiled to `fn.apply(key, 0)` — a `TypeError` at run time.
//
// Fixture: tests/fixtures/constructs/64-computed-method-names (v99 build).
// These assertions are structural (a builtin's number, a helper call is
// present, no `.apply(` shape survives), not a comparison against the whole
// decompiled output — CLAUDE.md's shared-fixture testing rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { getBuiltinTable } from "../../../src/tables/registry.ts";
import { decompile } from "../../../src/decompile.ts";

const FIXTURE = join(repoRoot(), "tests", "fixtures", "constructs", "64-computed-method-names");

test("hbc99-mar2026 builtin 55 is setFunctionName, and the privates above it are shifted by one", () => {
  const t = getBuiltinTable("hbc99-mar2026");
  const at = (n: number): string | undefined => t.builtins[n]?.name;
  assert.equal(at(54), "initRegexNamedGroups");
  assert.equal(at(55), "setFunctionName");
  assert.equal(at(56), "functionPrototypeApply");
  assert.equal(at(57), "functionPrototypeCall");
  assert.equal(at(58), "spawnAsync");
  assert.equal(at(59), "makeAsyncIterator");
  assert.equal(at(60), "awaitAsyncGenerator");
});

test("hbc99-feb2026 is deliberately NOT patched (no compiler this project runs produces it)", () => {
  assert.equal(getBuiltinTable("hbc99-feb2026").builtins[55]?.name, "functionPrototypeApply");
});

test("a v99 computed method name decompiles to the setFunctionName helper, not fn.apply(...)", () => {
  const bytes = new Uint8Array(readFileSync(join(FIXTURE, "v99.hbc")));
  const { code } = decompile(bytes, { resolveV98Ambiguity: true, moduleName: "64-computed-method-names" });
  // Four computed members in the fixture: one method, one getter, one setter,
  // one object-literal method — each one setFunctionName'd by hermesc.
  // One occurrence is the helper's own `function __hbc_b_setFunctionName(` header.
  const calls = (code.match(/__hbc_b_setFunctionName\(/g) ?? []).length - (code.match(/function __hbc_b_setFunctionName\(/g) ?? []).length;
  assert.equal(calls, 4, `expected 4 __hbc_b_setFunctionName call sites, got ${calls}`);
  assert.equal(code.includes("__hbc_b_functionPrototypeApply"), false, "the old, wrong builtin name must not appear");
  assert.match(code, /function __hbc_b_setFunctionName\(/, "the helper itself must be emitted into the prelude");
});

test("the decompiled v99 candidate reproduces the fixture's expected.txt", () => {
  const bytes = new Uint8Array(readFileSync(join(FIXTURE, "v99.hbc")));
  const { code } = decompile(bytes, { resolveV98Ambiguity: true, moduleName: "64-computed-method-names" });
  const lines: string[] = [];
  const print = (...a: unknown[]): void => void lines.push(a.join(" "));
  new Function("print", code)(print);
  assert.equal(lines.join("\n") + "\n", readFileSync(join(FIXTURE, "expected.txt"), "utf8"));
});
