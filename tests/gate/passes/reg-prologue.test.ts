// docs/BUGS.md 2026-09-01 "register prologue" row (F26,
// src/passes/index.ts's `hoistRegisterInits`). Fixture-level proof, on top
// of the hand-built-AST unit tests in tests/gate/passes/ast.test.ts: the
// leading `let r0, r1, …, rN;` prologue the emitter always produces
// (src/emit/function.ts) shrinks or disappears once passes are on, for a
// register whose first definition is a plain top-level statement — the
// `--passes=none` baseline (PL-05, tests/gate/passes/framework.test.ts)
// still shows the full hoisted decl, unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";

function loadFixture(name: string, version: number, variant: string): Uint8Array {
  return new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, `v${version}${variant}.hbc`)));
}

/** Only fn#1's own body — the fixture's other functions (the global init,
 *  fn#2/`hoistedFn`) are not this rung's concern. `fnToken` is `demo`
 *  (fn-naming recovered the name, passes on) or `_fn1` (`--passes=none`). */
function demoBody(code: string, fnToken: string): string {
  const start = code.indexOf(`function ${fnToken}(`);
  assert.notEqual(start, -1, `fixture shape changed: no \`function ${fnToken}(\``);
  const end = code.indexOf("\n    function ", start + 1);
  return end === -1 ? code.slice(start) : code.slice(start, end);
}

test("19-var-hoisting v94: with passes on, demo's leading multi-name register decl is gone (registers declared at first assignment instead)", () => {
  const withPasses = demoBody(decompile(loadFixture("19-var-hoisting", 94, ""), { moduleName: "x" }).code, "demo");
  // The M4 baseline shape this rung removes: a `let` naming two or more
  // plain `rN` registers on one line, right after the function opens.
  assert.doesNotMatch(withPasses, /let r\d+, r\d+/, "no multi-register hoisted decl should survive with passes on");
  // The registers this rung can prove safe to hoist now read as `let rN = …;`
  // in place of a bare `rN = …;`.
  assert.match(withPasses, /let r\d+ = /, "at least one register is declared at its first assignment");
});

test("19-var-hoisting v94: --passes=none keeps the full hoisted prologue (PL-05 baseline unaffected)", () => {
  const baseline = demoBody(decompile(loadFixture("19-var-hoisting", 94, ""), { moduleName: "x", passes: { none: true } }).code, "_fn1");
  assert.match(baseline, /let r0, r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12, r13;/, "the M4 baseline's hoisted-all-registers prologue is untouched by --passes=none");
});

test("19-var-hoisting v94: passes on never re-introduces a register the baseline never declared, and never drops one still read", () => {
  const bytes = loadFixture("19-var-hoisting", 94, "");
  const baseline = demoBody(decompile(bytes, { moduleName: "x", passes: { none: true } }).code, "_fn1");
  const withPasses = demoBody(decompile(bytes, { moduleName: "x" }).code, "demo");
  const baselineRegs = new Set(baseline.match(/\br\d+(?:_\d+)?\b/g) ?? []);
  const afterRegs = new Set(withPasses.match(/\br\d+(?:_\d+)?\b/g) ?? []);
  // Every base register number appearing after passes must have appeared
  // (as some name derived from it) in the baseline — no register is
  // invented, only renamed/split/promoted to `let … = …` in place.
  for (const r of afterRegs) {
    const base = r.replace(/_\d+$/, "");
    assert.ok(baselineRegs.has(base), `register ${r} (base ${base}) in passes-on output has no baseline counterpart`);
  }
});
