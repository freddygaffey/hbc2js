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
import { bucketAFunctions, fakeFunction, graphOf, realCfg } from "../../support/synth-module.ts";
import type { ModuleAnalysis } from "../../../src/cfg/types.ts";
import type { HbcModule } from "../../../src/parse/types.ts";
import { emitModule } from "../../../src/emit/index.ts";

const DONOR = join(repoRoot(), "tests", "fixtures", "constructs", "22-nested-closures-counters", "v99.hbc");

function emitBucketA(): ReturnType<typeof emitModule> {
  const donor = parseM4(new Uint8Array(readFileSync(DONOR))).module;
  const bodies = bucketAFunctions();
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
  const result = emitBucketA();
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
