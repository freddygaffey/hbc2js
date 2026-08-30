// docs/specs/07-pass-ladder.md §2.3 — the ordered list of enabled passes. The
// only place a pass is switched on. `--passes=none` reproduces the M4 baseline
// exactly, which is the required capability (PL-05).
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { forHeader } from "./for-header/index.ts";
import { loopCond } from "./loop-cond/index.ts";
import type { Pass, Stage } from "./types.ts";

/** Order is explicit data (§2.3). Stage A first; within a stage, dependency order. */
export const REGISTRY: readonly Pass[] = [loopCond as Pass, forHeader as Pass];

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
