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
 *  isolated with `--passes=none`. 32 after per-instance placement, 16
 *  after recursion-group hosting and **14** once a copy that captured a
 *  loop-local environment was emitted at its creation site, and **10** once a
 *  JOINED function (several aligned creation sites its body cannot tell apart,
 *  so one body) was hosted at the lowest common ancestor of those sites instead
 *  of beside the first one (report §5 "Landing item 4"). Ratchet: lower is fine, a rise is a
 *  regression. */
const MAX_ISOLATED = 10;
/** Individual unbound *names* behind those isolated functions (one isolated
 *  function can carry several). 158 before per-creation-context bodies, 155
 *  after, **63** once placement became a property of the emitted *instance*
 *  rather than of the function index (report §5 item 1: a child created over an
 *  environment its duplicated parent captured travels with each copy, and a
 *  copy's `emitName` no longer renames its children), and **28** once a copy
 *  hosted inside its own recursion group was emitted in every instance of that
 *  host (report §5 "Landing item 2": the 35 `_fn<n>__c<i>` went to 0, leaving
 *  only the 20 orphan-placement `_fn<n>` and 8 `_e<env>_<slot>`), and **26** once
 *  a copy hosted in the owner of a LOOP-LOCAL environment was emitted inline at
 *  its creation site instead of hoisted, where the loop block's `let` is not in
 *  scope (report §5 "Landing item 3": the 2 `_e2192_0` went to 0), and **22**
 *  once a joined function moved to the lowest common ancestor of its creation
 *  sites (report §5 "Landing item 4": `_fn13056` x5, `_fn15251`, `_fn15275`
 *  went to 0; 3 names came back — each rehosted function references one child
 *  created inside it over an environment IT captured, whose own home stayed
 *  behind, which is the "children travel" leftover). Still **22** after report
 *  §5 "Landing item 5": those three children each READ a slot of the very
 *  environment their creator's sites disagree about, so moving them with their
 *  creator only trades the 3 `_fn<n>` for 4 `_e<env>_<slot>` (measured 23).
 *  The rule that landed moves a child only where its own reads stay visible,
 *  which is none of these three on this bundle — they need per-instance
 *  `parentOf` (leftover 7). Same ratchet rule as above: it may go down,
 *  never up. */
const MAX_UNBOUND_NAMES = 22;
/** Orphans `resolveOrphanHosts` moves off module level on this fixture: 111 when
 *  every `W_AMBIGUOUS_CLOSURE_ENV` function was an orphan, **13** now that they
 *  are not. That drop is the point of per-creation-context bodies
 *  (docs/reports/2026-09-05-ambiguous-closure-env.md §4): a function created
 *  with two environments is emitted once per environment, each copy in the
 *  owner of the environment it captured, so placement has nothing to choose and
 *  is left with only the functions that have no resolved creation site at all.
 *  Still a floor, so losing the placement rule for *those* fails here. */
const MIN_HOSTED = 10;

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
  const unboundNames = isolated.reduce((n, d) => n + (d.message.match(/emitted identifier "/g) ?? []).length, 0);
  assert.ok(
    unboundNames <= MAX_UNBOUND_NAMES,
    `${unboundNames} identifiers are unbound across those functions, was ${MAX_UNBOUND_NAMES} — that number must only go down (docs/reports/2026-09-05-ambiguous-closure-env.md §5)`,
  );
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
/** Functions emitted once per creation context, and the ambiguous residual.
 *  Measured: 178 ambiguous -> 156 duplicated (335 extra bodies) + 4 joined by
 *  report §3 + **18** left ambiguous, which are exactly the ones whose creation
 *  sites have environment chains of *different length*, where no positional
 *  remap is defined. Ratchets in both directions: duplication must not silently
 *  stop happening, and the unaligned residual must not grow. */
const MIN_DUPLICATED = 150;
const MAX_STILL_AMBIGUOUS = 18;

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

  const duplicated = graph.closureCopies.size;
  const stillAmbiguous = analysis.diagnostics.filter((d) => d.code === "W_AMBIGUOUS_CLOSURE_ENV").length;
  assert.ok(
    duplicated >= MIN_DUPLICATED,
    `only ${duplicated} functions got per-creation-context bodies, expected at least ${MIN_DUPLICATED} (src/cfg/env-graph.ts \`closureCopies\`)`,
  );
  assert.ok(
    stillAmbiguous <= MAX_STILL_AMBIGUOUS,
    `${stillAmbiguous} functions are still W_AMBIGUOUS_CLOSURE_ENV, was ${MAX_STILL_AMBIGUOUS} (the unaligned residual) — that number must only go down (docs/reports/2026-09-05-ambiguous-closure-env.md §4)`,
  );
  for (const copies of graph.closureCopies.values()) {
    assert.ok(copies.length >= 2, "a function with per-creation-context copies must have at least two: one copy is not a duplication");
    assert.equal(copies[0]!.envRemap.size, 0, "copy 0 is the chain every recorded EnvAccess was resolved against; it renames nothing");
  }
});

// docs/BUGS.md 2026-09-04 (E_UNBOUND_IDENT hunt), re-measured 2026-09-05 after
// F24-5 (`W_NO_CAPTURE_HOSTED`) and per-creation-context closure copies: the
// residual on this bundle is UNCHANGED at 10 isolated / 22 unbound names
// (F24-5 hosts exactly 1 function on this bundle, `W_NO_CAPTURE_HOSTED`, and
// it was never part of the isolated residual). Bucketing the 10 by root cause
// (`src/cfg/env-graph.ts closureEnvOf`/`closureCreationSites`, cross-referenced
// against `W_AMBIGUOUS_CLOSURE_ENV`'s function indices):
//
//  - BUCKET 1 (7 of 10 — `_fn13838..13844`,`_fn13914..17`,`_fn14001..02` unbound,
//    13 `_fn<n>` references across `h`/`start`/`_fn11246`/`t`): each isolated
//    function creates or is one of the 18 `W_AMBIGUOUS_CLOSURE_ENV` "bucket C"
//    residual — created at sites whose environment chains have DIFFERENT
//    LENGTH, so `closureCopies`'s positional remap has no alignment to use
//    (`tests/gate/cfg/closure-copies.test.ts` "bucket C"). 3 of those 18
//    (`_fn14984/85/86`) are themselves isolated because their own bodies read
//    an `_e4551_*` slot of the very environment their 4 creation sites
//    disagree about (6 of the 22 unbound names, 3 distinct). This needs a
//    remap that tolerates unequal chain depths, not a placement change — the
//    docs/reports/2026-09-05-ambiguous-closure-env.md §4 test plan already
//    flags this as the unaligned residual, and no small `source.js` reproduces
//    it, so it is not a "<100 line" fix.
//  - BUCKET 2 (3 of 10 — `_fn15251`,`_fn15275`,`queryFn` i.e. `_fn13056`,
//    referencing `_fn15473`/`_fn15478`/`_fn14790`): report §5 "leftover 7" —
//    a JOINED function (`W_JOINED_REHOSTED`) moved to the lowest common
//    ancestor of its creation sites, but one child it creates over an
//    environment it merely CAPTURED (not created) stayed behind at the OLD
//    home, because that child's own reads are not visible from the new host
//    either. The report's own conclusion stands: this needs per-instance
//    `parentOf` (placement keyed by emitted copy, not by function index),
//    which is a design change, not a safe small patch.
//
// Neither bucket has a safe fix under ~100 lines, so nothing was landed for
// them this pass; this test pins the measured buckets as a ceiling, split by
// referenced-name kind, so a regression is caught even if the isolated/unbound
// TOTALS above happen to stay flat while the mix shifts.
//
// This also regression-tests `src/decompile.ts`: `analysis.envGraph` is a
// lazy getter whose OWN diagnostics (`W_AMBIGUOUS_CLOSURE_ENV`, among others)
// used to be silently dropped from `decompile()`'s result whenever nothing
// had read `.envGraph` before `decompile()` took its `[...analysis.diagnostics]`
// snapshot (the getter is what pushes them, and callers exercise it only
// inside the `emitModule` call, which runs AFTER that snapshot). Fixed by
// re-spreading `analysis.diagnostics` fresh at the very end. Before the fix,
// `cachedDecompile(...).diagnostics` reported ZERO `W_AMBIGUOUS_CLOSURE_ENV`
// on this bundle although `analyseModule(...).envGraph.diagnostics` reported
// 18 — this test's counts come from `cachedDecompile`, so it fails again if
// that snapshot-before-lazy-build bug comes back.
test("react-navigation-example-0.85.3: the residual E_UNBOUND_IDENT isolations bucket into two known, uncheap-to-fix causes", (t) => {
  if (!requireSweep(t)) return;
  if (!existsSync(HBC)) {
    t.skip(`${HBC} not present — run this fixture's fetch.sh first (INCONCLUSIVE, not a failure)`);
    return;
  }
  const result = cachedDecompile(readFileSync(HBC), { moduleName: "react-navigation-example.hbc", strictEnv: false });
  const isolated = result.diagnostics.filter((d) => d.code === "W_UNBOUND_ISOLATED");
  const names: string[] = [];
  for (const d of isolated) for (const m of d.message.matchAll(/emitted identifier "([^"]+)"/g)) names.push(m[1]!);
  const eSlotNames = names.filter((n) => /^_e\d+_\d+$/.test(n));
  const fnRefNames = names.filter((n) => /^_fn\d+$/.test(n));

  assert.equal(isolated.length, names.length === 0 ? 0 : isolated.length, "sanity: isolated diagnostics parsed");
  assert.ok(isolated.length <= MAX_ISOLATED, `${isolated.length} isolated functions, ceiling is ${MAX_ISOLATED} (this test's own bucket table)`);
  assert.ok(eSlotNames.length <= 6, `${eSlotNames.length} _e<env>_<slot> references unbound, was 6 (bucket 1's 3 self-reading ambiguous functions) — must only go down`);
  assert.ok(fnRefNames.length <= 16, `${fnRefNames.length} _fn<n> references unbound, was 16 (13 bucket 1 + 3 bucket 2) — must only go down`);

  // Regression for src/decompile.ts's diagnostic-assembly ordering: envGraph's
  // lazy diagnostics must survive into decompile()'s own result.
  const ambiguousViaDecompile = result.diagnostics.filter((d) => d.code === "W_AMBIGUOUS_CLOSURE_ENV").length;
  assert.ok(
    ambiguousViaDecompile > 0,
    "decompile()'s own diagnostics report zero W_AMBIGUOUS_CLOSURE_ENV on a bundle known to have 18 " +
      "(src/cfg/env-graph.ts) — analysis.envGraph's lazily-pushed diagnostics are being dropped again " +
      "(src/decompile.ts snapshots analysis.diagnostics before anything reads .envGraph)",
  );
  assert.ok(ambiguousViaDecompile <= MAX_STILL_AMBIGUOUS, `${ambiguousViaDecompile} via decompile(), ceiling is ${MAX_STILL_AMBIGUOUS}`);
});
