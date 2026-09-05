// docs/reports/2026-09-05-ambiguous-closure-env.md §4, emit half — one body per
// creation context. The env graph's `closureCopies` (tests/gate/cfg/closure-copies.test.ts)
// only says *which* environment each copy captures; this asserts what
// `emitModule` does with it: copy 0 keeps `_fn<n>` and its lexical home, copy i
// is `_fn<n>__c<i>` emitted inside the owner of the environment IT captured,
// each copy's body names its own `_e<env>_<slot>` variables, and each
// `Create*Closure` site references the copy it made — so nothing is unbound and
// nothing is silently bound to the wrong variable.
//
// Synthetic, for the reason §4's test plan gives: no small `source.js` makes
// hermesc deduplicate one function index across two lexical parents. The
// module's `layout`/`strings` are borrowed from a real fixture so the builtin
// table and string lookups are the real ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { parseM4 } from "../../support/m4.ts";
import type { Op } from "../../support/synth-module.ts";
import { bucketAFunctions, fakeFunction, graphOf, joinedChildFunctions, loopLocalCopyFunctions, mutualRecursionFunctions, realCfg, travelFunctions } from "../../support/synth-module.ts";
import type { ModuleAnalysis } from "../../../src/cfg/types.ts";
import type { HbcModule } from "../../../src/parse/types.ts";
import { emitModule } from "../../../src/emit/index.ts";

const DONOR = join(repoRoot(), "tests", "fixtures", "constructs", "22-nested-closures-counters", "v99.hbc");

function emitSynth(bodies: ReadonlyMap<number, readonly Op[]>): ReturnType<typeof emitModule> {
  const donor = parseM4(new Uint8Array(readFileSync(DONOR))).module;
  const fns = new Map([...bodies].map(([i, ops]) => [i, fakeFunction(i, ops)]));
  const cfgs = new Map([...fns].map(([i, f]) => [i, realCfg(f)]));
  const module = {
    ...donor,
    header: { ...donor.header, globalCodeIndex: 0, functionCount: fns.size },
    functions: [...fns.keys()].map((i) => ({ index: i })),
  } as unknown as HbcModule;
  const analysis: ModuleAnalysis = {
    module,
    envGraph: graphOf(bodies),
    kinds: [],
    cfg: (i) => cfgs.get(i)!,
    decoded: (i) => fns.get(i)!,
    options: { strictEnv: false, maxBlocks: 100000, checkInvariants: false },
    diagnostics: [],
  };
  return emitModule(analysis, { strictEnv: false, provenanceComments: false, moduleName: "synthetic.hbc" });
}

/** The text of `function <name>(…) { … }`, brace-matched. */
function bodyOf(code: string, name: string): string {
  const at = code.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `${name} was not emitted at all`);
  const open = code.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(open, i + 1);
  }
  throw new Error(`unterminated body for ${name}`);
}

test("a function created over two environments is emitted once per environment, each with its own env-slot names", (t) => {
  if (!existsSync(DONOR)) {
    t.skip(`${DONOR} not present — run tests/fixtures/constructs/build.sh (INCONCLUSIVE, not a failure)`);
    return;
  }
  const result = emitSynth(bucketAFunctions());
  const code = result.code;

  // Two bodies, not one.
  assert.match(code, /function _fn3\(/, "copy 0 keeps the plain name, so any reference the env graph did not record still resolves");
  assert.match(code, /function _fn3__c1\(/, "the second creation context needs its own body (report §4)");

  // Each copy names the environment IT captured. fn#1 makes env 1, fn#2 makes
  // env 2, and fn#3 reads slot 0 of whichever it was created with.
  assert.match(bodyOf(code, "_fn3"), /_e1_0/, "copy 0 reads env 1's slot");
  assert.doesNotMatch(bodyOf(code, "_fn3"), /_e2_0/);
  assert.match(bodyOf(code, "_fn3__c1"), /_e2_0/, "copy 1 must read env 2's slot, not env 1's — that substitution is the whole fix");
  assert.doesNotMatch(bodyOf(code, "_fn3__c1"), /_e1_0/);

  // Each copy is placed in the owner of its environment, and each creation site
  // references its own copy.
  const fn1 = bodyOf(code, "_fn1");
  const fn2 = bodyOf(code, "_fn2");
  assert.ok(fn1.includes("function _fn3(") && !fn1.includes("_fn3__c1"), "copy 0 belongs inside fn#1, which owns env 1");
  assert.ok(fn2.includes("function _fn3__c1(") && !/\b_fn3\b(?!__c)/.test(fn2.replace(/_fn3__c1/g, "")), "copy 1 belongs inside fn#2, which owns env 2");

  // Nothing was left dangling: no name needed a throwing stub, and no function
  // stayed ambiguous or orphaned.
  assert.deepEqual(
    result.diagnostics.filter((d) => d.code === "W_UNBOUND_ISOLATED" || d.code === "W_AMBIGUOUS_CLOSURE_ENV" || d.code === "W_ORPHAN_FUNCTION").map((d) => `${d.code}: ${d.message}`),
    [],
  );
  assert.equal(result.stubbedFunctions, 0);
});

// ---------------------------------------------------------------------------
// Report §5 item 1 — placement is a property of the INSTANCE, not of the
// function index. `tests/support/synth-module.ts`'s `travelFunctions` adds two
// children to the duplicated fn#3: fn#4, created over the environment fn#3
// *captured* (so `closureEnvOf` puts it beside copy 0, out of copy 1's scope)
// and also created from a non-duplicated site in fn#1; and fn#5, created over
// an environment fn#3 owns (an ordinary per-copy child).

test("a child created over the environment its duplicated parent captured gets one instance per copy", (t) => {
  if (!existsSync(DONOR)) {
    t.skip(`${DONOR} not present — run tests/fixtures/constructs/build.sh (INCONCLUSIVE, not a failure)`);
    return;
  }
  const result = emitSynth(travelFunctions());
  const copy1 = bodyOf(result.code, "_fn3__c1");

  // The instance travelled: it is emitted inside the copy that references it,
  // not left beside copy 0 where copy 1 cannot see it.
  assert.ok(copy1.includes("function _fn4("), "fn#4 has no instance inside copy 1, so copy 1's reference to it is unbound (report §5 item 1)");
  // …and it is remapped like the copy that hosts it: copy 1 captured env 2.
  assert.match(bodyOf(copy1, "_fn4"), /_e2_0/, "the travelling instance must read through the copy's own chain, not copy 0's");
  assert.doesNotMatch(bodyOf(copy1, "_fn4"), /_e1_0/);

  // Copy 0 is untouched: fn#1 still declares the instance its own,
  // non-duplicated creation site references. Moving the function index inward
  // instead of per instance is what took that away (report §5, reverted).
  const fn1 = bodyOf(result.code, "_fn1");
  assert.ok(fn1.includes("function _fn4("), "the non-duplicated site in fn#1 lost the instance it references");
  assert.match(bodyOf(fn1, "_fn4"), /_e1_0/, "copy 0's instance reads env 1");

  assert.deepEqual(
    result.diagnostics.filter((d) => d.code === "W_UNBOUND_ISOLATED" || d.code === "W_AMBIGUOUS_CLOSURE_ENV" || d.code === "W_ORPHAN_FUNCTION").map((d) => `${d.code}: ${d.message}`),
    [],
  );
  assert.equal(result.stubbedFunctions, 0);
});

test("a copy's children keep their own names — the copy's name renames the instance, not its subtree", (t) => {
  if (!existsSync(DONOR)) {
    t.skip(`${DONOR} not present — run tests/fixtures/constructs/build.sh (INCONCLUSIVE, not a failure)`);
    return;
  }
  const result = emitSynth(travelFunctions());
  const copy1 = bodyOf(result.code, "_fn3__c1");
  // Regression: the `emitName` of copy i used to be inherited by every child
  // emitted inside it, so fn#5 came out as `function _fn3__c1()` nested in
  // `_fn3__c1` — shadowing the copy inside its own body and leaving every
  // reference to `_fn5` unbound.
  assert.ok(copy1.includes("function _fn5("), "fn#5's instance inside copy 1 was emitted under the wrong name");
  assert.doesNotMatch(copy1, /function _fn3__c1\(/, "a child of copy 1 was named after the copy, shadowing it inside its own body");
  assert.ok(bodyOf(result.code, "_fn3").includes("function _fn5("), "copy 0 must keep its own child too");
});

// ---------------------------------------------------------------------------
// Report §5 "Landing item 2" — recursion GROUPS. `synth-module.ts`'s
// `mutualRecursionFunctions` is react-navigation's `_fn12406`/`_fn12407` in
// miniature: fn#3 and fn#4 create each other *and* themselves over an
// environment one of them owns, so two of each function's four copies are
// hosted *inside a member of the group*. Hosting those once, beside copy 0,
// leaves them invisible to every other instance of the group — the 35 unbound
// `_fn<n>__c<i>` names item 1 left behind.

test("a copy hosted inside its own recursion group is emitted in every instance of that host", (t) => {
  if (!existsSync(DONOR)) {
    t.skip(`${DONOR} not present — run tests/fixtures/constructs/build.sh (INCONCLUSIVE, not a failure)`);
    return;
  }
  const result = emitSynth(mutualRecursionFunctions());
  const code = result.code;

  // fn#4's copy over env 2 lives in fn#2, far from copy 0 of fn#3/fn#4 (both in
  // fn#1). Its body creates fn#3 and fn#4 over the environment IT owns, i.e.
  // the copies hosted in fn#4 — which must therefore travel into this instance.
  const inFn2 = bodyOf(code, "_fn4__c1");
  assert.ok(inFn2.includes("function _fn3__c3("), "the OTHER group member's copy hosted in fn#4 is not inside this instance of fn#4, so its reference is unbound (report §5 item 2)");
  assert.ok(inFn2.includes("function _fn4__c3("), "fn#4's own copy hosted in fn#4 is not inside this instance either");

  // …and the recursion stops: a copy is never nested inside itself. The site
  // that would do it is the self-reference its own declaration already binds.
  assert.doesNotMatch(bodyOf(code, "_fn3__c2"), /function _fn3__c2\(/, "a copy hosted inside its own group nested inside itself; the `hosted` set is what must stop that");
  assert.doesNotMatch(bodyOf(code, "_fn4__c3"), /function _fn4__c3\(/);

  assert.deepEqual(
    result.diagnostics.filter((d) => d.code === "W_UNBOUND_ISOLATED" || d.code === "W_AMBIGUOUS_CLOSURE_ENV" || d.code === "W_ORPHAN_FUNCTION").map((d) => `${d.code}: ${d.message}`),
    [],
  );
  assert.equal(result.stubbedFunctions, 0);
});

// ---------------------------------------------------------------------------
// Report §5 "Landing item 3" — a copy that captured a LOOP-LOCAL environment.
// `synth-module.ts`'s `loopLocalCopyFunctions` is react-navigation's
// `_fn10396__c1` / `_fn10397__c1` in miniature: copy 1 captures an environment
// its host creates inside a loop, so that environment's `let` is emitted in the
// loop body's own block and a copy hoisted to the top of the host cannot see it
// (`_e2_0` unbound, the function isolated). Copy 0's closures already take the
// inline function-expression form at their creation site for this reason; a
// copy has to as well.

test("a copy that captured a loop-local environment is emitted at its creation site, not hoisted", (t) => {
  if (!existsSync(DONOR)) {
    t.skip(`${DONOR} not present — run tests/fixtures/constructs/build.sh (INCONCLUSIVE, not a failure)`);
    return;
  }
  const result = emitSynth(loopLocalCopyFunctions());
  const code = result.code;

  assert.deepEqual(
    result.diagnostics.filter((d) => d.code === "W_UNBOUND_ISOLATED").map((d) => d.message),
    [],
    "copy 1 reads `_e2_0`, whose `let` is inside the loop block of its host — hoisting the copy puts it out of scope (report §5 item 3)",
  );
  assert.equal(result.stubbedFunctions, 0);

  // The copy exists, is named for its creation context, and is a function
  // *expression* at the site rather than a hoisted declaration.
  assert.match(code, /_fn3__c1/, "the second creation context still needs its own body");
  assert.doesNotMatch(code, /^\s*function _fn3__c1\(/m, "…but not as a hoisted declaration in statement position: it has to be the expression at its creation site");
  const inFn2 = bodyOf(code, "_fn2");
  assert.match(inFn2, /let _e2_0[\s\S]*=\s*function _fn3__c1\(/, "the copy must be created after, and inside the scope of, the loop-local `let` it reads");
  assert.match(bodyOf(code, "_fn3__c1"), /_e2_0/, "copy 1 reads env 2's slot through its remap");

  // Copy 0 is untouched: its host has no loop, so it keeps its own name and its
  // own env-slot names.
  assert.match(bodyOf(code, "_fn3"), /_e1_0/, "copy 0 reads env 1's slot");
  assert.doesNotMatch(bodyOf(code, "_fn3"), /_e2_0/);
});

test("a joined function is emitted where every one of its creation sites can see it", (t) => {
  if (!existsSync(DONOR)) {
    t.skip(`${DONOR} not present — run tests/fixtures/constructs/build.sh (INCONCLUSIVE, not a failure)`);
    return;
  }
  // Report §5 "Landing item 4". fn#1 and fn#2 are siblings, each makes its own
  // environment under the global one and creates fn#3 with it — aligned chains,
  // two distinct environments — but fn#3's body reads no slot at all, so
  // nothing in its subtree can tell the two apart and `src/cfg/env-graph.ts`
  // JOINS the sites: one body, `closureEnvOf === 1`, no `closureCopies` entry
  // (asserted in tests/gate/cfg/closure-copies.test.ts). That body used to be
  // emitted inside fn#1, the owner of env 1, where fn#2's `_fn3` reference is
  // unbound. On react-navigation that shape is `_fn13056` (six sites in six
  // different functions), `_fn15251` and `_fn15275`.
  const result = emitSynth(bucketAFunctions(false));
  const code = result.code;

  assert.deepEqual(
    result.diagnostics.filter((d) => d.code === "W_UNBOUND_ISOLATED").map((d) => d.message),
    [],
    "the site in fn#2 references a body hosted in fn#1, which fn#2 cannot see (report §5 item 4)",
  );
  assert.equal(result.stubbedFunctions, 0);

  // Still ONE body — the join is not duplication.
  assert.equal((code.match(/function _fn3\(/g) ?? []).length, 1, "a joined function is emitted once, not once per site");
  assert.doesNotMatch(code, /_fn3__c/, "…and it has no per-creation-context copies to name");

  // …hosted at the lowest common ancestor of the two creating functions, which
  // here is the global function, and referenced from both sites.
  assert.doesNotMatch(bodyOf(code, "_fn1"), /function _fn3\(/, "fn#1 is only one of the two sites; its body is not a home both can see");
  assert.doesNotMatch(bodyOf(code, "_fn2"), /function _fn3\(/);
  assert.match(bodyOf(code, "_fn1"), /=\s*_fn3;/, "fn#1's creation site still references it");
  assert.match(bodyOf(code, "_fn2"), /=\s*_fn3;/, "and so does fn#2's");
  assert.equal(
    result.diagnostics.filter((d) => d.code === "W_JOINED_REHOSTED").length,
    1,
    "the move is reported: it is a placement decision, not a graph one",
  );
});

test("a child a joined function creates travels with it when its own names allow", (t) => {
  if (!existsSync(DONOR)) {
    t.skip(`${DONOR} not present — run tests/fixtures/constructs/build.sh (INCONCLUSIVE, not a failure)`);
    return;
  }
  // Report §5 leftover 7. fn#3 is joined and re-hosted at the LCA of fn#1/fn#2
  // (the case above); fn#4 is created ONLY inside fn#3, but over the
  // environment fn#3 *captured*, so `closureEnvOf(4)` is env 1 — owner fn#1 —
  // and `parentOf` leaves it at fn#3's old home. Before the fix `_fn4` was
  // unbound inside the moved body (this is react-navigation's `_fn14790` /
  // `_fn15473` / `_fn15478` shape). It reads no env slot, so moving it with
  // its creator binds it.
  const result = emitSynth(joinedChildFunctions("movable"));

  assert.deepEqual(
    result.diagnostics.filter((d) => d.code === "W_UNBOUND_ISOLATED").map((d) => d.message),
    [],
    "the moved body references a child left behind at its old home (report §5 leftover 7)",
  );
  assert.equal(result.stubbedFunctions, 0);
  assert.equal(result.diagnostics.filter((d) => d.code === "W_JOINED_REHOSTED").length, 1, "fn#3 still moves to the LCA of its two sites");
  assert.deepEqual(
    result.diagnostics.filter((d) => d.code === "W_JOINED_CHILD_MOVED").map((d) => d.context.functionIndex),
    [4],
    "exactly the child whose every creation site is inside the moved function travels with it",
  );
  assert.match(bodyOf(result.code, "_fn3"), /function _fn4\(/, "…and it is emitted inside its creator, where the reference is");
  assert.doesNotMatch(bodyOf(result.code, "_fn1"), /function _fn4\(/, "…not at the home `closureEnvOf` gave it");
});

test("a child that reads the environment its creator's sites disagree about is duplicated with it, not pinned", (t) => {
  if (!existsSync(DONOR)) {
    t.skip(`${DONOR} not present — run tests/fixtures/constructs/build.sh (INCONCLUSIVE, not a failure)`);
    return;
  }
  // Report §6 (PUSHBACK P-46). fn#4 reads slot 0 of the environment fn#3
  // captured — env 1 at one site, env 2 at the other — so the two sites are
  // NOT indistinguishable and fn#3 must not be joined at all. It used to be:
  // `namesAgreeAcrossSites` walked the `closureEnvOf` subtree, which does not
  // contain fn#4, so one body was emitted, moved to the LCA of its sites, and
  // the child stayed behind (`W_JOINED_REHOSTED` + one unbound `_fn4` — the
  // react-navigation `_fn14790`/`_fn15473`/`_fn15478` shape, report §5
  // "Landing item 5", where moving it unconditionally traded 3 unbound
  // `_fn<n>` for 4 unbound `_e<env>_<slot>`). With the subtree creation-based
  // the sites conflict, fn#3 gets one body per creation context, and the child
  // travels into each copy under that copy's remap — so BOTH names bind and
  // neither copy's child reads the other context's environment.
  const result = emitSynth(joinedChildFunctions("pinned"));

  assert.deepEqual(
    result.diagnostics.filter((d) => d.code === "W_UNBOUND_ISOLATED").flatMap((d) => [...d.message.matchAll(/emitted identifier "([^"]+)"/g)].map((m) => m[1])),
    [],
    "nothing is left unbound: the child is no longer a joined function's orphaned descendant",
  );
  assert.equal(result.stubbedFunctions, 0);
  assert.deepEqual(result.diagnostics.filter((d) => d.code === "W_JOINED_REHOSTED"), [], "fn#3 is duplicated, so there is no single body to re-host");
  assert.deepEqual(result.diagnostics.filter((d) => d.code === "W_JOINED_CHILD_MOVED"), [], "…and no joined child to move either");
  assert.match(result.code, /function _fn3__c1\(/, "one body per creation context");
  assert.match(bodyOf(result.code, "_fn3__c1"), /_e2_0/, "copy 1's travelling child reads env 2, the environment copy 1 captured");
  assert.doesNotMatch(bodyOf(result.code, "_fn3__c1"), /_e1_0/, "…and never env 1, which is copy 0's");
});

test("the creation-based subtree runs to a fixed point in the emitter too: a grandchild travels with its copy", (t) => {
  if (!existsSync(DONOR)) {
    t.skip(`${DONOR} not present — run tests/fixtures/constructs/build.sh (INCONCLUSIVE, not a failure)`);
    return;
  }
  // Same shape one level deeper: fn#4 creates fn#5 over the environment fn#4
  // captured, and fn#5 is the reader. fn#4 belongs to fn#3's subtree only by
  // creation, and fn#5 only by fn#4's membership.
  const result = emitSynth(joinedChildFunctions("grandchild"));

  assert.deepEqual(
    result.diagnostics.filter((d) => d.code === "W_UNBOUND_ISOLATED").flatMap((d) => [...d.message.matchAll(/emitted identifier "([^"]+)"/g)].map((m) => m[1])),
    [],
    "a travelling child's own travelling child must reach the copy too",
  );
  assert.equal(result.stubbedFunctions, 0);
  assert.match(result.code, /function _fn3__c1\(/);
  assert.match(bodyOf(result.code, "_fn3__c1"), /_e2_0/, "the grandchild's read is remapped for copy 1's context");
});
