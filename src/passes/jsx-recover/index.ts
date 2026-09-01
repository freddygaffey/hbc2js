import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { JsxSites } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** `jsx(T, {…, children})` / `jsxs` / `jsxDEV` / `createElement(T, p, …c)`
 *  → `<T …>…</T>` — docs/LOWERING-CATALOGUE.md row R6, D20,
 *  docs/specs/passes/08-jsx-recovery.md. Stage B, **last** (spec §8: it
 *  wants plain calls, named callees, folded arrays/objects), and the
 *  ladder's one **opt-in** rung (spec §7): absent from the default pipeline,
 *  switched on by `--jsx`, whose output is JSX — human-facing, never what the
 *  equivalence gate executes. Without `--jsx` the printer lowers every `jsx`
 *  node back to its call, so even a pipeline that ran it stays runnable. */
export const jsxRecover: Pass<readonly Stmt[], JsxSites> = {
  name: "jsx-recover",
  stage: "B",
  targets: ["59-jsx-runtime-calls"],
  catalogue: ["R6"],
  after: ["expr-rebuild", "global-access", "call-shape", "template-literal", "fn-naming", "var-naming"],
  optIn: true,
  match,
  rewrite,
  check,
};
