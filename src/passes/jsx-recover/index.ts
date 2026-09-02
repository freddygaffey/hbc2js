import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { JsxSites } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** `jsx(T, {…, children})` / `jsxs` / `jsxDEV` / `createElement(T, p, …c)`
 *  → `<T …>…</T>` — docs/LOWERING-CATALOGUE.md row R6, D20,
 *  docs/specs/passes/08-jsx-recovery.md. Stage B, **last of the
 *  structure-recovery block** (D23's stage boundary, `registry.ts`: it
 *  wants plain calls, named callees, folded arrays/objects from every other
 *  structure rung, but runs *before* the renaming block — `fn-naming`,
 *  `reg-split`, `var-naming` — because it keys off a call *shape*, and
 *  `reg-split`'s per-store register renaming corrupted that shape when it
 *  ran first (docs/BUGS.md's 2026-09-02 P-11b row)). It is the ladder's one
 *  **opt-in** rung (spec §7): absent from the default pipeline, switched on
 *  by `--jsx`, whose output is JSX — human-facing, never what the
 *  equivalence gate executes. Without `--jsx` the printer lowers every `jsx`
 *  node back to its call, so even a pipeline that ran it stays runnable. */
export const jsxRecover: Pass<readonly Stmt[], JsxSites> = {
  name: "jsx-recover",
  stage: "B",
  targets: ["59-jsx-runtime-calls"],
  catalogue: ["R6"],
  after: ["expr-rebuild", "global-access", "call-shape", "default-params", "destructure", "spread-rest", "template-literal", "optional-chain"],
  optIn: true,
  match,
  rewrite,
  check,
};
