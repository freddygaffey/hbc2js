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
import { bucketAFunctions, fakeFunction, graphOf, realCfg, travelFunctions } from "../../support/synth-module.ts";
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
