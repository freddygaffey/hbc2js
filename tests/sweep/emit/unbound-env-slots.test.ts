// docs/BUGS.md 2026-09-04 (react-navigation `_e2326_0`) — the fixture that
// actually exhibited the loop-local-environment scope bug, and the standing
// count for the *other*, still-open unbound family (orphan functions emitted
// at module level that read an env slot declared inside some function; same
// row). Two things are asserted here:
//
//  1. `_e2326_0` (env 2326, created inside a loop in fn#4521, captured by the
//     inline `ref` closure fn#13735 created in a SIBLING block of the same
//     loop body) is no longer unbound. Before the `src/emit/index.ts` fix, the
//     `let _e2326_0` went inside the labelled block that holds the
//     `CreateEnvironment`, where the sibling block's inline closure cannot see
//     it, and the whole 15,551-function decompile threw E_UNBOUND_IDENT.
//  2. `_e652_0` (env 652, declared in fn#525) is no longer unbound either:
//     `_fn13838`…`_fn13843` are orphans — created at two sites with different
//     environments, so the env graph refuses to pick one — and used to be
//     emitted at MODULE level, outside the global function, where nothing any
//     function body declares is in scope. `src/emit/placement.ts` now hosts
//     each orphan where the fewest names are unbound.
//  3. The module still emits code at all: the surviving offenders are isolated
//     per function (`W_UNBOUND_ISOLATED`) rather than aborting the file. The
//     count is a ratchet, not an endorsement — every one of them is the open
//     BUGS.md row, and this number must only ever go down.
//
// INCONCLUSIVE-via-skip when the sweep tier isn't requested or the fixture's
// `.hbc` isn't present locally (run its `fetch.sh` first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { requireSweep } from "../../support/tiers.ts";
import { cachedDecompile } from "../../support/decompiled.ts";

const HBC = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.hbc");

/** Measured on this fixture (deb, node 22, passes on): 186 isolated functions
 *  at the loop-local-env fix commit (2810099), 103 after orphan placement
 *  (`src/emit/placement.ts`) — 541 unbound names down to 158, and 176 -> 106
 *  isolated with `--passes=none`. Ratchet: lower is fine, a rise is a
 *  regression. */
const MAX_ISOLATED = 103;
/** Orphans `resolveOrphanHosts` moves off module level on this fixture: 111.
 *  A floor, so losing the placement rule fails here and not only on the count
 *  above (which passes and structuring also move). */
const MIN_HOSTED = 100;

test("react-navigation-example-0.85.3: a loop-local env captured from a sibling block is declared, and the rest are isolated", (t) => {
  if (!requireSweep(t)) return;
  if (!existsSync(HBC)) {
    t.skip(`${HBC} not present — run this fixture's fetch.sh first (INCONCLUSIVE, not a failure)`);
    return;
  }
  const result = cachedDecompile(readFileSync(HBC), { moduleName: "react-navigation-example.hbc", strictEnv: false });
  assert.ok(result.code.length > 0, "the module emitted no code at all");

  const isolated = result.diagnostics.filter((d) => d.code === "W_UNBOUND_ISOLATED");
  const named = isolated.filter((d) => d.message.includes("_e2326_0"));
  assert.deepEqual(
    named.map((d) => d.message),
    [],
    "_e2326_0 is unbound again: a loop-local environment's `let` is being emitted where a closure created in a sibling block of the same loop body cannot see it (src/emit/index.ts, loop-local `closuresOutside` check)",
  );
  const stillUnbound = (name: string): string[] => isolated.filter((d) => d.message.includes(`"${name}"`)).map((d) => d.message);
  assert.deepEqual(
    stillUnbound("_e652_0"),
    [],
    "_e652_0 is unbound again: an orphan function (no resolved closure environment) is being emitted at module level while its body reads an env slot declared inside another function's body (src/emit/placement.ts)",
  );
  assert.ok(
    result.diagnostics.filter((d) => d.code === "W_ORPHAN_HOSTED").length >= MIN_HOSTED,
    `only ${result.diagnostics.filter((d) => d.code === "W_ORPHAN_HOSTED").length} orphans were hosted inside a function, expected at least ${MIN_HOSTED} (src/emit/placement.ts)`,
  );
  assert.ok(isolated.length <= MAX_ISOLATED, `${isolated.length} functions isolated for E_UNBOUND_IDENT, was ${MAX_ISOLATED} at the fix commit — that number must only go down (docs/BUGS.md 2026-09-04)`);
});

/** docs/BUGS.md 2026-09-04, cause (b): 4,009 of this bundle's 4,187 orphan
 *  functions were not orphans at all — they are created with an *undefined*
 *  environment operand (`LoadConstUndefined rE; CreateClosure rD, rE, fn`),
 *  which is Hermes stating that the closure captures nothing. `src/cfg/env-graph.ts`
 *  now records that as a known-empty environment, so `W_ORPHAN_FUNCTION` on this
 *  bundle went 4,009 -> 0 and every one of those functions carries its own
 *  `selfEnv` (null) into the fixed point instead of poisoning it. A ratchet: it
 *  may go down, never up. */
const MAX_ORPHAN_FUNCTIONS = 0;
/** Functions the graph knows capture nothing. A floor, so losing the `none`
 *  lattice value fails here and not only on the count above. Measured: 4,188
 *  (4,009 undefined-operand closures + the 178 W_AMBIGUOUS_CLOSURE_ENV ones +
 *  the global function). */
const MIN_KNOWN_EMPTY_ENV = 4000;

test("react-navigation-example-0.85.3: a closure created with an undefined environment operand is not an orphan", (t) => {
  if (!requireSweep(t)) return;
  if (!existsSync(HBC)) {
    t.skip(`${HBC} not present — run this fixture's fetch.sh first (INCONCLUSIVE, not a failure)`);
    return;
  }
  const mod = parseHbc(readFileSync(HBC));
  const analysis = analyseModule(mod, { strictEnv: false });
  const graph = analysis.envGraph;
  const orphans = analysis.diagnostics.filter((d) => d.code === "W_ORPHAN_FUNCTION");
  assert.ok(
    orphans.length <= MAX_ORPHAN_FUNCTIONS,
    `${orphans.length} functions have no known closure creation environment, was ${MAX_ORPHAN_FUNCTIONS} at the fix commit — that number must only go down (docs/BUGS.md 2026-09-04, src/cfg/env-graph.ts \`none\` lattice value)`,
  );
  let knownEmpty = 0;
  for (let i = 0; i < mod.functions.length; i++) if (graph.closureEnvOf.has(i) && graph.closureEnvOf.get(i) === null) knownEmpty++;
  assert.ok(
    knownEmpty >= MIN_KNOWN_EMPTY_ENV,
    `only ${knownEmpty} functions are recorded as capturing nothing, expected at least ${MIN_KNOWN_EMPTY_ENV} (src/cfg/env-graph.ts)`,
  );
});
