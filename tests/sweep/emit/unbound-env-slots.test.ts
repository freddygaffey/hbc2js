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
//  2. The module still emits code at all: the surviving offenders are isolated
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
import { requireSweep } from "../../support/tiers.ts";
import { cachedDecompile } from "../../support/decompiled.ts";

const HBC = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.hbc");

/** Measured on this fixture at the fix commit: 186 isolated functions, none of
 *  them `_e2326_0`. Ratchet: lower is fine, a rise is a regression. */
const MAX_ISOLATED = 186;

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
  assert.ok(isolated.length <= MAX_ISOLATED, `${isolated.length} functions isolated for E_UNBOUND_IDENT, was ${MAX_ISOLATED} at the fix commit — that number must only go down (docs/BUGS.md 2026-09-04)`);
});
