// docs/specs/07-pass-ladder.md §2.3 — the ordered list of enabled passes. The
// only place a pass is switched on. `--passes=none` reproduces the M4 baseline
// exactly, which is the required capability (PL-05).
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { callShape } from "./call-shape/index.ts";
import { exprRebuild } from "./expr-rebuild/index.ts";
import { fnNaming } from "./fn-naming/index.ts";
import { forHeader } from "./for-header/index.ts";
import { globalAccess } from "./global-access/index.ts";
import { ifChain } from "./if-chain/index.ts";
import { labelClean } from "./label-clean/index.ts";
import { loopCond } from "./loop-cond/index.ts";
import { switchRaise } from "./switch-raise/index.ts";
import type { Pass, Stage } from "./types.ts";
import { varNaming } from "./var-naming/index.ts";

/** Order is explicit data (§2.3). Stage A first; within a stage, dependency
 *  order — `expr-rebuild` is first in stage B (PL-11), enforced below by
 *  injecting `after: ["expr-rebuild"]` into every other stage-B rung.
 *  `global-access` runs right after it (docs/specs/passes/03-global-access.md
 *  §7): it needs the member read `expr-rebuild` has already inlined into its
 *  consumer to locate it at all, and must land before `call-shape`
 *  (docs/specs/passes/04-call-shape.md §7: `call-shape`'s own `after`
 *  declares both dependencies explicitly, so no `before` needed on
 *  `global-access`'s side). `fn-naming` (docs/specs/passes/05-fn-naming.md
 *  §7) runs last: `after: ["expr-rebuild", "global-access"]` only — it needs
 *  no explicit ordering against `call-shape` (neither reads or writes a
 *  shape the other depends on), so it is simply appended. `label-clean`
 *  (docs/specs/passes/06-label-clean.md §7) is last in stage A, `after:
 *  ["loop-cond", "for-header", "if-chain"]`: every other stage-A rung
 *  removes label uses, so it must see the final tree before stage B ever
 *  runs. `if-chain` (docs/specs/passes/09-if-chain.md §7) sits between
 *  them, `after: ["loop-cond", "for-header"]` — a guard `if` inside an
 *  unformed loop is the loop's test, and flattening its `else` first would
 *  hide the tail-guard shape `loop-cond` keys on. `switch-raise`
 *  (docs/specs/passes/10-switch-raise.md §7) shares that `after` (a compare
 *  chain inside an unformed loop looks like a dispatcher) and registers
 *  **before** `if-chain`, so its S2 (compare-chain) rule, when F13 lands,
 *  sees the else-spine before `if-chain` flattens it; `label-clean`'s
 *  `after` gains it for the same reason as `if-chain`.
 *  `var-naming` (docs/specs/passes/07-var-naming.md §8) runs last of all:
 *  `after: ["expr-rebuild", "call-shape", "fn-naming"]` — it names registers
 *  on the fully-cleaned tree (post `expr-rebuild` folding) with `fn-naming`'s
 *  recovered names already in its collision set, and needs `call-shape` to
 *  have turned a disguised call back into a real callee so its call-result
 *  heuristic sees one. */
export const REGISTRY: readonly Pass[] = [loopCond as Pass, forHeader as Pass, switchRaise as Pass, ifChain as Pass, labelClean as Pass, exprRebuild as Pass, globalAccess as Pass, callShape as Pass, fnNaming as Pass, varNaming as Pass];

export interface EnabledPassOptions {
  readonly only?: readonly string[];
  readonly skip?: readonly string[];
  readonly stage?: Stage;
}

/**
 * Order is explicit data, not import order. `after`/`before` constraints are
 * validated here, at selection time rather than at run time, so a mis-ordered
 * ladder fails the first test rather than the fortieth fixture.
 *
 * §2.3: every stage-B pass except `expr-rebuild` gets `after: ["expr-rebuild"]`
 * injected before validation.
 */
export function enabledPasses(opts: EnabledPassOptions = {}, registry: readonly Pass[] = REGISTRY): readonly Pass[] {
  // review M5-pass-1 F5: a mistyped `only`/`skip` name, or an `after`/`before`
  // naming a pass that does not exist anywhere in the registry, used to be
  // silently ignored — `--no-pass nonexistent` exited 0 and disabled nothing.
  // Validated against the *whole* registry, not the stage/only/skip-filtered
  // list below: a dependency on a name that exists but got filtered out is
  // fine (its ordering constraint is simply moot); a dependency on a name
  // that never existed anywhere is always a mistake.
  const allNames = new Set(registry.map((p) => p.name));
  for (const name of opts.only ?? []) {
    if (!allNames.has(name)) throw new Hbc2jsError(ErrorCode.E_PASS_ORDER, `--passes names unknown pass "${name}"`, { section: "passes/registry" });
  }
  for (const name of opts.skip ?? []) {
    if (!allNames.has(name)) throw new Hbc2jsError(ErrorCode.E_PASS_ORDER, `--no-pass names unknown pass "${name}"`, { section: "passes/registry" });
  }
  for (const p of registry) {
    for (const dep of [...(p.after ?? []), ...(p.before ?? [])]) {
      if (!allNames.has(dep)) throw new Hbc2jsError(ErrorCode.E_PASS_ORDER, `pass "${p.name}" declares a dependency on unknown pass "${dep}"`, { section: "passes/registry" });
    }
  }

  let list = registry.filter((p) => (opts.stage === undefined || p.stage === opts.stage) && (opts.only === undefined || opts.only.includes(p.name)) && (opts.skip === undefined || !opts.skip.includes(p.name)));

  list = list.map((p) => (p.stage === "B" && p.name !== "expr-rebuild" && !(p.after ?? []).includes("expr-rebuild") ? { ...p, after: [...(p.after ?? []), "expr-rebuild"] } : p));

  const position = new Map(list.map((p, i) => [p.name, i]));
  for (const [i, p] of list.entries()) {
    for (const dep of p.after ?? []) {
      const at = position.get(dep);
      if (at !== undefined && at > i) {
        throw new Hbc2jsError(ErrorCode.E_PASS_ORDER, `pass "${p.name}" declares after:["${dep}"] but "${dep}" is registered later`, { section: "passes/registry" });
      }
    }
    for (const dep of p.before ?? []) {
      const at = position.get(dep);
      if (at !== undefined && at < i) {
        throw new Hbc2jsError(ErrorCode.E_PASS_ORDER, `pass "${p.name}" declares before:["${dep}"] but "${dep}" is registered earlier`, { section: "passes/registry" });
      }
    }
  }
  return list;
}
