// docs/specs/passes/25-yield-async-recovery.md -- spec 25 section 3.4's generator-shape checker, re-derived with this
// rung's own recovery options.
import { makeCheck } from "../tree.ts";

export const check = makeCheck({ loops: false });
