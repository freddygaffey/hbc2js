// Spec 28 landing 2 (section 0a, section 9.4's REWRITE row): the LLM may
// rewrite a function, and the result is kept ONLY if the equivalence oracle
// says the program still behaves identically to the bytecode. One acceptance
// test per class -- accepted, DIVERGENT, unparseable, INCONCLUSIVE -- each
// asserting what survives a rejection is the faithful original, and a
// cross-cutting assertion that no accepted rewrite ever carries a non-PASS
// proof.
//
// No exact-output assertion on the shared fixture (docs/CONSOLIDATION.md
// section B item 7): every candidate here is DERIVED from whatever the
// decompiler renders today (wrap the body, inject a print), so this file keeps
// working when the emitter changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { repoRoot } from "../../support/paths.ts";
import { requireOracles } from "../../support/tiers.ts";
import { decompile } from "../../../src/decompile.ts";
import { findHermesVm } from "../../../src/harness/hermes-vm.ts";
import type { FunctionEquivRequest, FunctionEquivResult, FunctionEquivVerdict } from "../../../src/harness/hbc-equiv.ts";
import {
  emittedFunctionName,
  findFunctionSpan,
  gateRewrite,
  rewriteSidecar,
  runRewritePass,
  sha256,
  spliceRewrite,
  validateRewriteRecord,
} from "../../../src/readability/rewrite.ts";
import type { RewriteAttempt } from "../../../src/readability/rewrite.ts";
import { parseReadabilityResult } from "../../../src/readability/types.ts";
import type { RewriteProposal } from "../../../src/readability/types.ts";

const FIXTURE = "04-for-loop-basic";
const VERSION = 84;
const FN = 0;
const FN_NAME = emittedFunctionName(FN);

function hbcPath(): string {
  return join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, `v${String(VERSION)}.hbc`);
}

function faithfulRender(): string {
  return decompile(new Uint8Array(readFileSync(hbcPath()))).code;
}

function vmOrSkip(t: TestContext): boolean {
  if (findHermesVm(VERSION) !== null) return true;
  const msg = `no Hermes VM for HBC v${String(VERSION)}; the REWRITE gate's oracle cannot run`;
  if (requireOracles()) throw new Error(msg);
  t.skip(msg);
  return false;
}

function fnText(code: string): string {
  const span = findFunctionSpan(code, FN_NAME);
  assert.notEqual(span, undefined, `the render should contain function ${FN_NAME}`);
  return code.slice(span!.start, span!.end);
}

/** A semantically identical restatement: the whole body moves into an inner
 *  closure called with the same `this`. Derived from the render, so it stays
 *  valid however the emitter changes. */
function equivalentRewrite(code: string): string {
  const text = fnText(code);
  const open = text.indexOf("{");
  const body = text.slice(open + 1, text.lastIndexOf("}"));
  return `function ${FN_NAME}() {\n  return (function () {${body}}).call(this);\n}`;
}

/** A rewrite that changes what the program does: one extra printed line. */
function divergentRewrite(code: string): string {
  const text = fnText(code);
  const open = text.indexOf("{");
  return `${text.slice(0, open + 1)}\n  print("rewritten");${text.slice(open + 1)}`;
}

function proposal(code: string, over: Partial<RewriteProposal> = {}): RewriteProposal {
  return { fn: FN, code, confidence: "med", evidence: "restated the lowered loop", ...over };
}

function stubOracle(verdict: FunctionEquivVerdict): (req: FunctionEquivRequest) => Promise<FunctionEquivResult> {
  return (req) =>
    Promise.resolve({
      verdict,
      why: `stub ${verdict}`,
      oracle: `hbc2js equiv --hbc ${req.hbcPath} <candidate>`,
      coverage: { inputs: 0, records: verdict === "INCONCLUSIVE" ? 0 : 4 },
      legs: [{ name: "module-hbc", verdict, why: `stub ${verdict}` }],
    });
}

// Every attempt any test in this file makes is recorded here, and the last
// test asserts the invariant over all of them at once.
const attempts: RewriteAttempt[] = [];
function record(a: RewriteAttempt): RewriteAttempt {
  attempts.push(a);
  return a;
}

test("splice: a rewrite replaces exactly its own function and nothing else", () => {
  const code = faithfulRender();
  const span = findFunctionSpan(code, FN_NAME);
  assert.notEqual(span, undefined);
  const spliced = spliceRewrite(code, proposal(equivalentRewrite(code)));
  assert.equal(spliced.ok, true, spliced.ok ? "" : spliced.detail);
  if (!spliced.ok) return;
  assert.equal(spliced.code.slice(0, span!.start), code.slice(0, span!.start), "text before the function is untouched");
  assert.equal(spliced.code.slice(spliced.code.length - (code.length - span!.end)), code.slice(span!.end), "text after the function is untouched");
  assert.notEqual(spliced.code, code, "the function itself did change");
});

test("ACCEPTED: an equivalent rewrite passes equiv --hbc and lands as a suggested change record", async (t) => {
  if (!vmOrSkip(t)) return;
  const code = faithfulRender();
  const attempt = record(
    await gateRewrite(proposal(equivalentRewrite(code)), { faithfulCode: code, hbcPath: hbcPath(), outputPath: "src/module_0.js", inputs: [{ module: 0 }] }),
  );
  assert.equal(attempt.verdict, "ACCEPTED", attempt.detail);
  assert.equal(attempt.proof?.verdict, "PASS");
  assert.equal(attempt.proof?.scope, "function");
  assert.match(attempt.proof?.oracle ?? "", /^hbc2js equiv --hbc /);
  assert.ok((attempt.proof?.coverage.records ?? 0) > 0, "an accepted proof states the coverage it rests on");
  assert.notEqual(attempt.code, code, "the accepted rewrite is what the caller now holds");

  const rec = attempt.record;
  assert.notEqual(rec, undefined, "an accepted rewrite is recorded");
  assert.equal(rec?.tier, "suggested", "the model never self-promotes (spec 28 section 1d)");
  assert.equal(rec?.who, "worker:haiku");
  assert.deepEqual(validateRewriteRecord(rec!), [], "the record is structurally valid");
  assert.equal(rec?.prior.files[0]?.sha256, sha256(code), "the faithful original is recorded, so the change is reversible");
  assert.deepEqual(rec?.outputs[0]?.origins, [{ module: 0 }], "zero orphans: the output traces to bytecode");
  assert.match(rewriteSidecar([rec!]), /"change": "rewrite"/);
});

test("REJECTED DIVERGENT: a rewrite that changes a result is discarded and the faithful original stands", async (t) => {
  if (!vmOrSkip(t)) return;
  const code = faithfulRender();
  const attempt = record(await gateRewrite(proposal(divergentRewrite(code)), { faithfulCode: code, hbcPath: hbcPath() }));
  assert.equal(attempt.verdict, "REJECTED_DIVERGENT", attempt.detail);
  assert.equal(attempt.accepted, false);
  assert.equal(attempt.proof?.verdict, "DIVERGENT", "the attempt is logged with its proof");
  assert.equal(attempt.record, undefined, "nothing is recorded for a rejected rewrite");
  assert.equal(attempt.code, code, "the faithful original is what survives");
});

test("REJECTED PARSE: an unparseable rewrite never reaches the oracle", async () => {
  const code = faithfulRender();
  let oracleRuns = 0;
  const attempt = record(
    await gateRewrite(proposal(`function ${FN_NAME}() { return (; }`), {
      faithfulCode: code,
      hbcPath: hbcPath(),
      oracle: (req) => {
        oracleRuns += 1;
        return stubOracle("PASS")(req);
      },
    }),
  );
  assert.equal(attempt.verdict, "REJECTED_PARSE");
  assert.equal(oracleRuns, 0, "an invalid candidate is refused by construction, before any VM runs");
  assert.equal(attempt.proof, undefined);
  assert.equal(attempt.code, code, "the faithful original is what survives");
});

test("REJECTED SHAPE: valid JS that is not the function it claims to replace is refused", async () => {
  const code = faithfulRender();
  const attempt = record(
    await gateRewrite(proposal("function somethingElse() { return 1; }"), { faithfulCode: code, hbcPath: hbcPath(), oracle: stubOracle("PASS") }),
  );
  assert.equal(attempt.verdict, "REJECTED_SHAPE");
  assert.equal(attempt.code, code);
});

test("REJECTED INCONCLUSIVE: an unproven rewrite is refused exactly like a divergent one", async () => {
  const code = faithfulRender();
  const attempt = record(await gateRewrite(proposal(equivalentRewrite(code)), { faithfulCode: code, hbcPath: hbcPath(), oracle: stubOracle("INCONCLUSIVE") }));
  assert.equal(attempt.verdict, "REJECTED_INCONCLUSIVE");
  assert.equal(attempt.accepted, false);
  assert.equal(attempt.proof?.verdict, "INCONCLUSIVE");
  assert.equal(attempt.record, undefined);
  assert.equal(attempt.code, code, "the faithful original is what survives");
});

test("a rewrite whose module run observed nothing is INCONCLUSIVE, not PASS", async () => {
  const code = faithfulRender();
  const attempt = record(
    await gateRewrite(proposal(equivalentRewrite(code)), {
      faithfulCode: code,
      hbcPath: hbcPath(),
      // A module that printed one line, with no function body to fall back on:
      // thin coverage, so the gate refuses rather than calling it proven.
      oracle: (req) =>
        Promise.resolve({
          verdict: "INCONCLUSIVE" as const,
          why: "only 1 output line observed (thin coverage)",
          oracle: `hbc2js equiv --hbc ${req.hbcPath} <candidate>`,
          coverage: { inputs: 0, records: 1 },
          legs: [{ name: "module-hbc" as const, verdict: "INCONCLUSIVE" as const, why: "thin" }],
        }),
    }),
  );
  assert.equal(attempt.accepted, false);
  assert.equal(attempt.verdict, "REJECTED_INCONCLUSIVE");
});

test("runRewritePass: only the accepted proposal changes the render, and it is the one that is recorded", async (t) => {
  if (!vmOrSkip(t)) return;
  const code = faithfulRender();
  const result = await runRewritePass([proposal(divergentRewrite(code)), proposal(equivalentRewrite(code))], {
    faithfulCode: code,
    hbcPath: hbcPath(),
    outputPath: "src/module_0.js",
    inputs: [{ module: 0 }],
  });
  for (const a of result.attempts) record(a);
  assert.deepEqual(
    result.attempts.map((a) => a.verdict),
    ["REJECTED_DIVERGENT", "ACCEPTED"],
  );
  assert.equal(result.records.length, 1, "exactly one suggested change record");
  assert.notEqual(result.code, code);
  assert.equal(faithfulRender(), code, "nothing on disk changed: the faithful render is still what the decompiler produces");
});

test("the model's `rewrite` field parses as a candidate, and carries no authority of its own", () => {
  const parsed = parseReadabilityResult(JSON.stringify({ names: [], rewrite: { fn: 3, code: "function _fn3() {}", confidence: "high", evidence: "" } }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.result.rewrite?.fn, 3);
  assert.equal(parsed.result.rewrite?.confidence, "low", "evidence-free can never be high (spec 28 sections 1 and 4)");
  assert.equal(parsed.result.abstained, false, "a rewrite-only answer is not an abstention");
  const bad = parseReadabilityResult(JSON.stringify({ names: [], rewrite: { fn: -1, code: "", confidence: "high", evidence: "x" } }));
  assert.equal(bad.ok, false, "a malformed rewrite is a rejected candidate, not a crash");
});

test("no accepted rewrite anywhere in this file carries a non-PASS proof", () => {
  // Four attempts need no VM (parse, shape, and the two stubbed-oracle
  // rejections); the rest only run where a v84 Hermes VM exists.
  assert.ok(attempts.length >= 4, `expected every gated attempt to be collected, saw ${String(attempts.length)}`);
  for (const a of attempts) {
    assert.equal(a.accepted, a.verdict === "ACCEPTED", `${a.verdict}: accepted must mean exactly ACCEPTED`);
    if (a.accepted) {
      assert.equal(a.proof?.verdict, "PASS", "an accepted rewrite always has a PASS proof");
      assert.notEqual(a.record, undefined);
    } else {
      assert.equal(a.record, undefined, "a rejected rewrite is never recorded as a change");
      assert.notEqual(a.proof?.verdict, "PASS", "a rejection never carries a PASS proof");
    }
  }
});
