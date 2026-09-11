// Spec 28 landing 5 (sections 1b step 8, 1d.1, 9.6): the pluggable, opt-in
// evaluation-loop host, its three shipped plugins, and the adversarial
// re-check. No network: every backend here is `FakeBackend`/`ReplayBackend`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { FakeBackend } from "../../../src/workers/backend.ts";
import { ReferenceNameRater, evaluationModeFor, highConfidenceAccuracy } from "../../../src/readability/types.ts";
import type { Confidence } from "../../../src/name-overlay/store.ts";
import type { CallSurface, EvaluationMode, LabelledSample } from "../../../src/readability/types.ts";
import {
  NONE_PLUGIN,
  applyAdversarialDemotion,
  createAgentEvaluatorPlugin,
  createInlineCallerPlugin,
  needsAdversarialRecheck,
  parseVerdictResponse,
  runAdversarialRecheck,
  runEvaluation,
} from "../../../src/readability/evaluate.ts";

const SAMPLE_PATH = join(repoRoot(), "tests", "fixtures", "llm-readability", "react-navigation-example-0.85.3.labels.json");
function sample(): LabelledSample {
  return JSON.parse(readFileSync(SAMPLE_PATH, "utf8")) as LabelledSample;
}

// ---------------------------------------------------------------------------
// Mode selection table (spec 28 section 9.6): every surface x requested combo.
// ---------------------------------------------------------------------------

test("spec 28 section 9.6: evaluationModeFor over every surface x requested combination", () => {
  const surfaces: readonly CallSurface[] = ["ui", "mcp", "cli"];
  const requestable: readonly EvaluationMode[] = ["human-ui", "agent", "inline-caller", "none"];
  for (const surface of surfaces) {
    for (const requested of requestable) {
      const mode = evaluationModeFor({ surface, requested });
      if (surface === "ui") {
        assert.equal(mode, "human-ui", `ui + requested=${requested} must always be human-ui`);
      } else {
        assert.equal(mode, requested, `${surface} + requested=${requested} must honour what the caller wired`);
      }
    }
    // No `requested` at all: ui still human-ui, automated surfaces default none.
    const bare = evaluationModeFor({ surface });
    assert.equal(bare, surface === "ui" ? "human-ui" : "none");
  }
});

// ---------------------------------------------------------------------------
// The three shipped plugins, round-tripped.
// ---------------------------------------------------------------------------

test("spec 28: the `none` plugin returns an empty report and never calls anything", async () => {
  const report = await runEvaluation([{ targetId: "t1", proposedName: "x.js", confidence: "high", evidence: "e" }], NONE_PLUGIN);
  assert.equal(report.evaluator, "none");
  assert.equal(report.mode, "none");
  assert.deepEqual(report.verdicts, []);
});

test("spec 28: the `inline-caller` plugin never spawns a backend -- it returns a pending-caller shape for the caller to fill", async () => {
  const plugin = createInlineCallerPlugin();
  const report = await runEvaluation(
    [
      { targetId: "t1", proposedName: "x.js", confidence: "high", evidence: "e" },
      { targetId: "t2", proposedName: "y.js", confidence: "low", evidence: "" },
    ],
    plugin,
  );
  assert.equal(report.mode, "inline-caller");
  assert.equal(report.verdicts.length, 2);
  for (const v of report.verdicts) assert.equal(v.verdict, "pending-caller");
});

test("spec 28: the `agent` plugin calls the wired backend once per item via the `evaluate` job kind + `hbc-evaluate` skill", async () => {
  const backend = new FakeBackend({
    replies: {
      evaluate: (req) => {
        const ctx = req.context as { proposedName: string };
        return JSON.stringify({
          verdict: ctx.proposedName === "bad.js" ? "misleading" : "accurate",
          rationale: `graded ${ctx.proposedName}`,
        });
      },
    },
  });
  const plugin = createAgentEvaluatorPlugin({ backend });
  const report = await runEvaluation(
    [
      { targetId: "t1", proposedName: "good.js", confidence: "high", evidence: "e1" },
      { targetId: "t2", proposedName: "bad.js", confidence: "high", evidence: "e2" },
    ],
    plugin,
  );
  assert.equal(report.evaluator, "agent");
  assert.equal(backend.seen.length, 2);
  assert.equal(backend.seen[0]?.kind, "evaluate");
  assert.equal(report.verdicts.find((v) => v.targetId === "t1")?.verdict, "accurate");
  assert.equal(report.verdicts.find((v) => v.targetId === "t2")?.verdict, "misleading");
});

test("spec 28: a malformed evaluator response is a low-information verdict, never a crash", () => {
  assert.equal(parseVerdictResponse("not json").verdict, "inaccurate");
  assert.equal(parseVerdictResponse("{}").verdict, "inaccurate");
  assert.equal(parseVerdictResponse(JSON.stringify({ verdict: "nonsense", rationale: "x" })).verdict, "inaccurate");
  assert.equal(parseVerdictResponse(JSON.stringify({ verdict: "misleading", rationale: "ok" })).verdict, "misleading");
});

// ---------------------------------------------------------------------------
// The report is judgements only, and `runEvaluation` never touches the DB.
// ---------------------------------------------------------------------------

test("spec 28 section 9.6: EvaluationReport has no promotion field, structurally, for every plugin", async () => {
  const plugins = [NONE_PLUGIN, createInlineCallerPlugin(), createAgentEvaluatorPlugin({ backend: new FakeBackend({}) })];
  for (const plugin of plugins) {
    const report = await runEvaluation([{ targetId: "t1", proposedName: "x.js", confidence: "low", evidence: "" }], plugin);
    assert.ok(!("promote" in report), `${plugin.id}: report must not carry a promotion field`);
    assert.ok(!("tier" in report), `${plugin.id}: report must not carry a tier field`);
    assert.ok(!("txId" in report), `${plugin.id}: report must not carry a transaction id`);
    assert.deepEqual(Object.keys(report).sort(), ["evaluator", "mode", "verdicts"]);
  }
});

test("spec 28: runEvaluation takes no db/tier argument at all -- an evaluation cannot promote by construction", () => {
  // `runEvaluation`'s own arity is the structural proof: (items, plugin, signal?)
  // -- three parameters, none named `db`/`tier`/`promote`.
  assert.equal(runEvaluation.length, 3);
  assert.equal(runEvaluation.toString().includes("db"), false);
  assert.equal(runEvaluation.toString().includes("promote"), false);
});

// ---------------------------------------------------------------------------
// The adversarial re-check (section 1b step 8, section 4).
// ---------------------------------------------------------------------------

test("spec 28 section 1b step 8: needsAdversarialRecheck gates on security-relevance or high-confidence + high reach", () => {
  assert.equal(needsAdversarialRecheck({ securityRelevant: true, confidence: "low" }), true);
  assert.equal(needsAdversarialRecheck({ securityRelevant: false, confidence: "high" }), false, "no reach at all never qualifies on the reach leg");
  assert.equal(needsAdversarialRecheck({ securityRelevant: false, confidence: "high", reach: 5 }), false);
  assert.equal(needsAdversarialRecheck({ securityRelevant: false, confidence: "high", reach: 100 }), true);
  assert.equal(needsAdversarialRecheck({ securityRelevant: false, confidence: "med", reach: 100 }), false, "reach only counts at high confidence");
});

test("spec 28 section 1b step 8: the recheck skips non-qualifying targets and never charges them a call", async () => {
  const backend = new FakeBackend({ replies: { "adversarial-recheck": () => JSON.stringify({ verdict: "accurate", rationale: "fine" }) } });
  const verdicts = await runAdversarialRecheck(
    [
      { targetId: "low-value", proposedName: "x.js", confidence: "med", evidence: "e", securityRelevant: false },
      { targetId: "high-value", proposedName: "y.js", confidence: "high", evidence: "e", securityRelevant: true },
    ],
    backend,
  );
  assert.equal(backend.seen.length, 1, "only the qualifying target is charged a call");
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]?.targetId, "high-value");
});

test("spec 28 section 1b step 8: a planted misleading name on a security-relevant target is caught and demoted", async () => {
  const backend = new FakeBackend({
    replies: {
      "adversarial-recheck": (req) => {
        const ctx = req.context as { proposedName: string };
        return ctx.proposedName === "trustedInternalUtils.js"
          ? JSON.stringify({ verdict: "misleading", rationale: "asserts trust the evidence never establishes" })
          : JSON.stringify({ verdict: "accurate", rationale: "fine" });
      },
    },
  });
  const proposals = new Map<string, { name: string; confidence: Confidence; evidence: string }>([
    ["safe-target", { name: "useLinking.js", confidence: "high", evidence: "deep-link handler" }],
    ["security-target", { name: "trustedInternalUtils.js", confidence: "high", evidence: "url handling helpers" }],
  ]);
  const verdicts = await runAdversarialRecheck(
    [
      { targetId: "safe-target", proposedName: "useLinking.js", confidence: "high", evidence: "deep-link handler", securityRelevant: true },
      { targetId: "security-target", proposedName: "trustedInternalUtils.js", confidence: "high", evidence: "url handling helpers", securityRelevant: true },
    ],
    backend,
  );
  const demoted = applyAdversarialDemotion(proposals, verdicts);
  assert.equal(demoted.get("safe-target")?.confidence, "high", "an accurate verdict must not touch the proposal");
  assert.equal(demoted.get("security-target")?.confidence, "low", "a misleading verdict must demote to low");
  assert.match(demoted.get("security-target")?.evidence ?? "", /^\[flagged: misleading\]/);
});

// ---------------------------------------------------------------------------
// Section 7's clause, over the labelled sample with a replay-shaped backend
// that includes at least one planted misleading proposal.
// ---------------------------------------------------------------------------

test("spec 28 section 7: zero misleading verdicts survive on security-relevant targets after the re-check, over the labelled sample", async () => {
  const s = sample();
  const security = s.targets.find((t) => t.securityRelevant);
  assert.ok(security !== undefined, "the sample must carry a security-relevant target to exercise this clause");

  const rater = new ReferenceNameRater();
  const proposals = new Map<string, { name: string; confidence: Confidence; evidence: string }>();
  for (const t of s.targets) {
    // Every non-security target gets its own reference name (accurate); the
    // security-relevant one gets a planted misleading proposal.
    proposals.set(t.id, t.securityRelevant ? { name: "safeInternalHelper.js", confidence: "high", evidence: "helper module" } : { name: t.referenceName, confidence: "high", evidence: "matches" });
  }
  const before = highConfidenceAccuracy(rater, s, proposals);
  assert.ok(before !== undefined && before.misleading >= 1, "the planted proposal must actually trip the rater before any recheck runs");

  const backend = new FakeBackend({
    replies: {
      "adversarial-recheck": (req) => {
        const ctx = req.context as { targetId: string };
        return ctx.targetId === security!.id
          ? JSON.stringify({ verdict: "misleading", rationale: "planted misrepresentation" })
          : JSON.stringify({ verdict: "accurate", rationale: "fine" });
      },
    },
  });
  const adversarialTargets = [...proposals.entries()].map(([targetId, p]) => {
    const target = s.targets.find((t) => t.id === targetId);
    return { targetId, proposedName: p.name, confidence: p.confidence, evidence: p.evidence, securityRelevant: target?.securityRelevant ?? false };
  });
  const verdicts = await runAdversarialRecheck(adversarialTargets, backend);
  const demoted = applyAdversarialDemotion(proposals, verdicts);
  const after = highConfidenceAccuracy(rater, s, demoted);
  assert.ok(after !== undefined);
  assert.equal(after.misleading, 0, "section 7: zero misleading names on security-relevant targets survive the verify pass");
});
