// docs/specs/passes/25-yield-async-recovery.md -- the site is the shared one (spec 25 section 3.1): one *generator
// group* per enclosing function body. The analysis is framework
// (`src/passes/generator-shape.ts`), reached through `../tree.ts` as D12a
// requires; this rung is the `loops: false` instance of it.
import { makeMatch } from "../tree.ts";

export type { YieldSite } from "../tree.ts";
export const match = makeMatch({ loops: false });
