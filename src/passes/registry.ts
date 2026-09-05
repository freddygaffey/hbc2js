// docs/specs/07-pass-ladder.md §2.3 — the ordered list of enabled passes. The
// only place a pass is switched on. `--passes=none` reproduces the M4 baseline
// exactly, which is the required capability (PL-05).
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { argumentsForm } from "./arguments-form/index.ts";
import { asyncRecovery } from "./async-recovery/index.ts";
import { literalForms } from "./literal-forms/index.ts";
import { callShape } from "./call-shape/index.ts";
import { classRecover } from "./class-recover/index.ts";
import { ctorThis } from "./ctor-this/index.ts";
import { superCall } from "./super-call/index.ts";
import { defaultParams } from "./default-params/index.ts";
import { destructure } from "./destructure/index.ts";
import { spreadRest } from "./spread-rest/index.ts";
import { optionalChain } from "./optional-chain/index.ts";
import { objectLiteral } from "./object-literal/index.ts";
import { privateFields } from "./private-fields/index.ts";
import { exprRebuild } from "./expr-rebuild/index.ts";
import { fnNaming } from "./fn-naming/index.ts";
import { forHeader } from "./for-header/index.ts";
import { forIn } from "./for-in/index.ts";
import { forOf } from "./for-of/index.ts";
import { globalAccess } from "./global-access/index.ts";
import { globalthisDeadStore } from "./globalthis-dead-store/index.ts";
import { ifChain } from "./if-chain/index.ts";
import { labelClean } from "./label-clean/index.ts";
import { loopCond } from "./loop-cond/index.ts";
import { regSplit } from "./reg-split/index.ts";
import { switchRaise } from "./switch-raise/index.ts";
import { jsxRecover } from "./jsx-recover/index.ts";
import { templateLiteral } from "./template-literal/index.ts";
import { tryClean } from "./try-clean/index.ts";
import { tryShape } from "./try-shape/index.ts";
import type { Pass, Stage } from "./types.ts";
import { varNaming } from "./var-naming/index.ts";
import { yieldRecovery } from "./yield-recovery/index.ts";

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
 *  `template-literal` (docs/specs/passes/14-template-literal.md §7) sits
 *  after `call-shape`: `after: ["expr-rebuild", "global-access"]` (folded
 *  argument arrays, inlined chunk registers) and `before: ["var-naming"]`
 *  (it deletes the template-object register, which must never have been
 *  named); it is order-independent of `call-shape`, whose rules all refuse
 *  a concat site (asserted by negative tests in both rungs, not by an
 *  edge).
 *
 *  **Stage boundary (D23): structure-recovery before renaming.** Every
 *  stage-B rung is either a *structure-recovery* rung (rewrites shape:
 *  `expr-rebuild` … `optional-chain`, `jsx-recover`) or a *pure-renaming*
 *  rung (`fn-naming`, `reg-split`, `var-naming` — comments on all three say
 *  "no statement moves, no expression changes shape"). All structure-
 *  recovery rungs are registered before all renaming rungs, so a renaming
 *  rung may assume the tree's shape is final and a structure rung may
 *  assume every register still carries its original bytecode identity
 *  (renaming has not run yet). `jsx-recover` (docs/specs/passes/
 *  08-jsx-recovery.md §7/§8) is therefore registered **last of the
 *  structure-recovery block**, not last overall (D23 supersedes D20's old
 *  "last in stage B" — it moved because it recognises a call *shape*, which
 *  `reg-split`'s per-store register renaming was corrupting before the
 *  renaming rung it keys off had even seen the tree; docs/BUGS.md's
 *  2026-09-02 P-11b row). It is still the ladder's one `optIn` rung:
 *  `enabledPasses` leaves it out unless `optIn: ["jsx-recover"]` (`--jsx`)
 *  names it, so the default pipeline — the one the equivalence gate
 *  executes — never holds a `jsx` node. `fn-naming` (docs/specs/passes/
 *  05-fn-naming.md §7) opens the renaming block: `after: ["expr-rebuild",
 *  "global-access", "jsx-recover"]` — it needs the free global names
 *  `global-access` exposes (condition 4, "captures-free-name") and must
 *  run after every structure rung including `jsx-recover`. `reg-split`
 *  (docs/specs/passes/19-reg-split.md §7) runs next, `var-naming`
 *  (docs/specs/passes/07-var-naming.md §8) last of all: `after:
 *  ["expr-rebuild", "call-shape", "fn-naming"]` — it names registers on the
 *  fully-cleaned, fully-structured tree with `fn-naming`'s recovered names
 *  already in its collision set, and needs `call-shape` to have turned a
 *  disguised call back into a real callee so its call-result heuristic
 *  sees one. */
export const REGISTRY: readonly Pass[] = [
  loopCond as Pass,
  forHeader as Pass,
  forIn as Pass,
  forOf as Pass,
  switchRaise as Pass,
  ifChain as Pass,
  tryShape as Pass,
  labelClean as Pass,
  exprRebuild as Pass,
  globalAccess as Pass,
  globalthisDeadStore as Pass,
  callShape as Pass,
  defaultParams as Pass,
  destructure as Pass,
  spreadRest as Pass,
  templateLiteral as Pass,
  optionalChain as Pass,
  objectLiteral as Pass,
  yieldRecovery as Pass,
  asyncRecovery as Pass,
  // Spec 23 section 2 / 00-LADDER.md batch 4: both are surface rungs on
  // emitter output (no new bytecode fact), registered after `object-literal`
  // and before `jsx-recover` — after every rung that changes an expression's
  // shape, before every renaming rung (`fn-naming`/`reg-split`/`var-naming`).
  argumentsForm as Pass,
  literalForms as Pass,
  tryClean as Pass,
  // Spec 24 section 2 (P-21/D23): the class rung is a structure-recovery rung
  // and must see registers with their original bytecode identity, so it is
  // registered after `object-literal` (its descriptor argument must already be
  // an `object` node) and before every renaming rung.
  classRecover as Pass,
  // R13 (docs/specs/passes/28-super-call.md): rebuilds a DERIVED class
  // constructor's `Reflect.construct(Object.getPrototypeOf(<class>), [args],
  // new.target)` lowering into `super(args)`. It reads the `class` node
  // `class-recover` builds AND the `_eD_S = <class>` store in the enclosing
  // function body (R-SC1's evidence), so it is registered immediately after
  // it and before `ctor-this`, which refuses a derived class outright.
  superCall as Pass,
  // R12 (docs/specs/passes/26-ctor-this.md): replaces the base-class
  // constructor's `new.target.prototype` stand-in with the real `this`. It
  // reads the `class` node `class-recover` builds and it must land before
  // `private-fields`, whose install shape is only recognisable once the
  // constructor's target IS `this`.
  ctorThis as Pass,
  // Private-name follow-up (docs/BUGS.md 2026-09-01 "class private fields"):
  // needs the `class` node `classRecover` just built, and the same register
  // identity, so it sits immediately after it and before every renaming rung.
  privateFields as Pass,
  jsxRecover as Pass,
  fnNaming as Pass,
  regSplit as Pass,
  varNaming as Pass,
];

export interface EnabledPassOptions {
  readonly only?: readonly string[];
  readonly skip?: readonly string[];
  readonly stage?: Stage;
  /** `Pass.optIn` rungs to switch on (`--jsx` → `["jsx-recover"]`); an
   *  opt-in rung absent from here (and from `only`) is never selected. */
  readonly optIn?: readonly string[];
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

  for (const name of opts.optIn ?? []) {
    if (!allNames.has(name)) throw new Hbc2jsError(ErrorCode.E_PASS_ORDER, `opt-in names unknown pass "${name}"`, { section: "passes/registry" });
  }

  const selected = (p: Pass): boolean => (p.optIn !== true || (opts.optIn?.includes(p.name) ?? false) || (opts.only?.includes(p.name) ?? false)) && (opts.stage === undefined || p.stage === opts.stage) && (opts.only === undefined || opts.only.includes(p.name)) && (opts.skip === undefined || !opts.skip.includes(p.name));
  let list = registry.filter(selected);

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
