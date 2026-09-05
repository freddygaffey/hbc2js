// docs/BUGS.md's superlinear-pass row, part 5, soundness half.
//
// `expr-rebuild/check.ts` now *derives* the whole-function register-use map
// for the list it just accepted, instead of leaving the next driver
// iteration to rebuild it from scratch: `noteRegisterUsesSplice` in
// `src/passes/ast.ts` subtracts the replaced window's counts and adds the
// replacement window's, on the concatenativity argument `registerUseDelta`
// already stands on. If that derivation is ever wrong the pass silently
// mis-answers D-b ("is `rX` written exactly once and read exactly here?"),
// which decides whether a store may be deleted - a correctness bug, not a
// performance one.
//
// So: for every prefix of every shape below, the derived map must equal a
// cold `registerUses` walk of the very same statements, key for key and
// count for count. A structural clone of the resulting body gives a fresh
// array identity, so `registerUses` walks it cold - that is the oracle.
// Every intermediate derivation is covered because a run that stops after
// `k` sites composes exactly `k` derivations, and `k` runs from 1 upward.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { applyAstPasses, registerUses, registerUsesIfMemoised } from "../../../src/passes/ast.ts";
import { exprRebuild } from "../../../src/passes/expr-rebuild/index.ts";
import type { ModuleView } from "../../../src/passes/tree.ts";
import type { Pass, PassContext } from "../../../src/passes/types.ts";

function baseCtx(): Omit<PassContext, "applied" | "structured" | "parentOf" | "fnBody"> {
  const module: ModuleView = {
    functionCount: 1,
    functionName: (): string => "global",
    isGlobalFunction: (index: number): boolean => index === 0,
    envSlotAccesses: (): readonly { readonly functionIndex: number; readonly offset: number }[] => [],
    depsVerdict: (): null => null,
  };
  return {
    analysis: null as unknown as PassContext["analysis"],
    functionIndex: 0,
    cfg: {} as PassContext["cfg"],
    hbcVersion: 94,
    layoutClass: "hbc94" as PassContext["layoutClass"],
    diagnostic: () => {},
    module,
  };
}

const call = (callee: string, args: readonly Stmt[] extends never ? never : ReturnType<typeof id>[]): Stmt => ({ k: "expr", expr: { k: "call", callee: id(callee), args } });
const store = (reg: string, n: number): Stmt => ({ k: "expr", expr: { k: "assign", target: id(reg), value: { k: "call", callee: id("source"), args: [lit(String(n))] } } });
const pureStore = (reg: string, n: number): Stmt => ({ k: "expr", expr: { k: "assign", target: id(reg), value: { k: "bin", op: "+", left: lit(String(n)), right: lit("1") } } });
const selfStore = (reg: string): Stmt => ({ k: "expr", expr: { k: "assign", target: id(reg), value: id(reg) } });

/** R1a with a unique register per site (the module-root shape). */
function uniqueRegs(k: number): readonly Stmt[] {
  const b: Stmt[] = [];
  for (let n = 0; n < k; n++) {
    b.push(store(`r${n}`, n));
    b.push(call("use", [id(`r${n}`)]));
  }
  return b;
}

/** R1a with a small reused register alphabet, so later sites see counts the
 *  earlier derivations already changed. */
function reusedRegs(k: number): readonly Stmt[] {
  const b: Stmt[] = [];
  for (let n = 0; n < k; n++) {
    b.push(store(`r${n % 3}`, n));
    b.push(call("use", [id(`r${n % 3}`)]));
  }
  return b;
}

/** R1b (pure dead store, deleted outright), R1b impure (store survives as a
 *  bare expression statement) and R1c (self-assign) interleaved with R1a. */
function mixedRules(k: number): readonly Stmt[] {
  const b: Stmt[] = [];
  for (let n = 0; n < k; n++) {
    b.push(pureStore(`p${n}`, n)); // no reader anywhere: R1b, deleted
    b.push(store(`q${n}`, n)); // impure, no reader: R1b, remnant kept
    b.push(selfStore(`s${n}`)); // R1c
    b.push(store(`r${n}`, n));
    b.push(call("use", [id(`r${n}`)]));
  }
  return b;
}

/** The folds live inside a nested `if` body, so `ctx.fnBody` and the matched
 *  list are different objects - the derivation must not fire on a list it
 *  was not proven for. */
function nested(k: number): readonly Stmt[] {
  const inner: Stmt[] = [];
  for (let n = 0; n < k; n++) {
    inner.push(store(`r${n}`, n));
    inner.push(call("use", [id(`r${n}`)]));
  }
  return [{ k: "if", test: id("cond"), then: inner, else: [] }, call("tail", [])];
}

const shapes: readonly { readonly name: string; readonly build: (k: number) => readonly Stmt[] }[] = [
  { name: "unique registers (module-root shape)", build: uniqueRegs },
  { name: "reused register alphabet", build: reusedRegs },
  { name: "R1a/R1b/R1b-impure/R1c mixed", build: mixedRules },
  { name: "folds inside a nested if body", build: nested },
];

function sameCounts(derived: ReadonlyMap<string, { reads: number; writes: number; nested: number }>, cold: ReadonlyMap<string, { reads: number; writes: number; nested: number }>): string | null {
  const names = new Set<string>([...derived.keys(), ...cold.keys()]);
  for (const name of [...names].sort()) {
    const d = derived.get(name);
    const c = cold.get(name);
    if (d === undefined || c === undefined) return `${name}: derived=${JSON.stringify(d)} cold=${JSON.stringify(c)}`;
    if (d.reads !== c.reads || d.writes !== c.writes || d.nested !== c.nested) return `${name}: derived=${JSON.stringify(d)} cold=${JSON.stringify(c)}`;
  }
  return null;
}

test("the register-use map carried across each expr-rebuild splice equals a cold walk of the same list", () => {
  let derivationsSeen = 0;
  for (const shape of shapes) {
    for (let k = 1; k <= 8; k++) {
      const body = shape.build(k);
      const result = applyAstPasses(body, [exprRebuild as unknown as Pass<readonly Stmt[]>], baseCtx());
      assert.equal(result.abandoned.length, 0, `${shape.name} k=${k}: ${JSON.stringify(result.abandoned.slice(0, 2))}`);
      assert.ok(result.applied.length > 0, `${shape.name} k=${k}: nothing applied, the shape proves nothing`);
      const derived = registerUsesIfMemoised(result.body);
      if (derived === undefined) continue; // no derivation fired (nested-list shapes): nothing to differ from
      derivationsSeen++;
      const cold = registerUses(structuredClone(result.body) as readonly Stmt[]);
      assert.equal(sameCounts(derived, cold), null, `${shape.name} k=${k}: derived register-use map differs from a cold walk`);
    }
  }
  assert.ok(derivationsSeen >= 8, `expected the splice derivation to fire on most shapes, saw it ${derivationsSeen} times`);
});
