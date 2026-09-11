// Spec 28 sections 1d.1, 1e and 9.7: the three call surfaces (UI / MCP / CLI)
// and the pluggable, opt-in evaluator. The vocabulary is pinned against the
// spec text so a landing cannot rename a tool without editing the spec in the
// same commit; the evaluator's default selection and plug-in shape are green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import {
  CALL_SURFACES,
  EVALUATION_MODES,
  READABILITY_CLI_VERBS,
  READABILITY_MCP_TOOLS,
  READABILITY_UI_ACTIONS,
  ReferenceNameRater,
  evaluationModeFor,
} from "../../../src/readability/types.ts";
import type { EvaluationItem, EvaluationReport, EvaluatorPlugin, LabelledSample } from "../../../src/readability/types.ts";

const SPEC_PATH = join(repoRoot(), "docs", "specs", "28-llm-readability.md");
const MCP_TOOLS_PATH = join(repoRoot(), "src", "mcp", "tools.ts");
const SAMPLE_PATH = join(repoRoot(), "tests", "fixtures", "llm-readability", "react-navigation-example-0.85.3.labels.json");
const EVAL_PATH = join(repoRoot(), "src", "readability", "evaluate.ts");

function specLine(prefix: string): readonly string[] {
  const spec = readFileSync(SPEC_PATH, "utf8");
  const line = spec.split("\n").find((l) => l.startsWith(prefix));
  assert.ok(line !== undefined, `docs/specs/28-llm-readability.md must carry a line starting "${prefix}"`);
  return line
    .slice(prefix.length)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

test("spec 28 section 9.7: the spec text and the code agree on every surface's vocabulary", () => {
  assert.deepEqual(specLine("MCP tools: "), [...READABILITY_MCP_TOOLS]);
  assert.deepEqual(specLine("CLI verbs: "), [...READABILITY_CLI_VERBS]);
  assert.deepEqual(specLine("UI actions: "), [...READABILITY_UI_ACTIONS]);
});

test("spec 28 section 1e: MCP tool names follow the existing snake_case convention and do not collide", () => {
  const existing = readFileSync(MCP_TOOLS_PATH, "utf8");
  for (const name of READABILITY_MCP_TOOLS) {
    assert.match(name, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, `${name} is not snake_case`);
    // `promote`/`revert` already exist on the spec-17 surface with different
    // argument shapes, so the readability verbs are deliberately suffixed.
    if (name === "promote_change" || name === "revert_change") continue;
    assert.ok(
      !existing.includes(`\`${name}\``),
      `${name} already names a spec-17 MCP tool; pick a name that does not collide`,
    );
  }
  assert.equal(new Set(READABILITY_MCP_TOOLS).size, READABILITY_MCP_TOOLS.length);
});

test("spec 28 section 1d.1: a human on the UI is the reviewer; automated surfaces get what they wired", () => {
  assert.deepEqual([...CALL_SURFACES], ["ui", "mcp", "cli"]);
  assert.deepEqual([...EVALUATION_MODES], ["human-ui", "agent", "inline-caller", "none"]);

  // UI: never spawn an evaluator, even if one is requested.
  assert.equal(evaluationModeFor({ surface: "ui" }), "human-ui");
  assert.equal(evaluationModeFor({ surface: "ui", requested: "agent" }), "human-ui");
  // Automated: opt-in, defaulting to raw suggested + equiv-verified results.
  assert.equal(evaluationModeFor({ surface: "mcp" }), "none");
  assert.equal(evaluationModeFor({ surface: "cli" }), "none");
  assert.equal(evaluationModeFor({ surface: "mcp", requested: "agent" }), "agent");
  assert.equal(evaluationModeFor({ surface: "cli", requested: "inline-caller" }), "inline-caller");
});

test("spec 28 section 1d.1: an evaluator is a plug-in, not a hard-wired model, and never promotes", async () => {
  const s = JSON.parse(readFileSync(SAMPLE_PATH, "utf8")) as LabelledSample;
  const byId = new Map(s.targets.map((t) => [t.id, t]));
  const rater = new ReferenceNameRater();

  // A trivial plug-in built on the offline rater: any object with these three
  // members is a legal evaluator, whatever is behind it.
  const plugin: EvaluatorPlugin = {
    id: "offline-reference",
    mode: "agent",
    async evaluate(items: readonly EvaluationItem[]): Promise<EvaluationReport> {
      return {
        evaluator: "offline-reference",
        mode: "agent",
        verdicts: items.map((i) => {
          const target = byId.get(i.targetId);
          assert.ok(target !== undefined, `unknown target ${i.targetId}`);
          return { targetId: i.targetId, ...rater.rate(target, i.proposedName) };
        }),
      };
    },
  };

  const report = await plugin.evaluate([
    { targetId: "rn-ex-04", proposedName: "StackRouter.js", confidence: "high", evidence: 'action type "PUSH"' },
    { targetId: "rn-ex-08", proposedName: "stringUtils.js", confidence: "high", evidence: "none" },
  ]);
  assert.equal(report.evaluator, "offline-reference");
  assert.equal(report.verdicts.length, 2);
  assert.equal(report.verdicts[0]?.verdict, "accurate");
  assert.equal(report.verdicts[1]?.verdict, "misleading");
  // The report carries judgements only: there is no promotion field at all.
  assert.ok(!Object.keys(report).includes("promote"));
});

test("spec 28 section 1e: the MCP tools and UI actions are registered end to end", async (t) => {
  if (!existsSync(join(repoRoot(), "src", "readability", "surfaces.ts"))) {
    t.skip("src/readability/surfaces.ts does not exist yet -- spec 28 LANDING 4 (MCP tools + UI actions)");
    return;
  }
  // Landing 4: every tool is registered with a schema, and a round trip
  // through the registered handler returns equiv-verified, DB-tracked
  // results -- the same properties `tests/gate/llm-readability/surfaces.test.ts`
  // and `tests/mcp/readability-tools.test.ts` check in depth; this leg only
  // proves registration is real, not faked to satisfy the vocabulary check
  // above.
  const { registerReadabilityTools } = await import("../../../src/mcp/tools.ts");
  const { makeTree } = await import("../../support/readability-tree.ts");
  const { FakeBackend } = await import("../../../src/workers/backend.ts");
  const { db, treeDir, projectDir } = makeTree();
  const handlers = registerReadabilityTools({ db, projectDir, treeDir, backend: new FakeBackend({}) });
  assert.deepEqual(Object.keys(handlers).sort(), [...READABILITY_MCP_TOOLS].sort());
  const result = handlers.list_suggestions({}) as { suggestions: unknown[]; total: number };
  assert.deepEqual(result, { suggestions: [], total: 0 });
});

test("spec 28 section 1d.1: the evaluation loop runs end to end for an automated caller", async (t) => {
  if (!existsSync(EVAL_PATH)) {
    t.skip(`${EVAL_PATH} does not exist yet -- spec 28 LANDING 5 (evaluation loop)`);
    return;
  }
  const { registerReadabilityTools } = await import("../../../src/mcp/tools.ts");
  const { makeTree } = await import("../../support/readability-tree.ts");
  const { FakeBackend } = await import("../../../src/workers/backend.ts");
  const { createAgentEvaluatorPlugin } = await import("../../../src/readability/evaluate.ts");
  const { listTransactions } = await import("../../../src/readability/transactions.ts");
  const { db, treeDir, projectDir } = makeTree();
  const hbcPath = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v84.hbc");

  // A backend that grades every name "accurate" -- the point of this test is
  // that a report comes back and nothing is promoted by it, not what the
  // grade is.
  const backend = new FakeBackend({ replies: { "suggest-name": () => JSON.stringify({ names: [{ bindingId: { kind: "reg", fn: 0, reg: 0 }, name: "x", confidence: "low", evidence: "e" }] }) } });
  const evalBackend = new FakeBackend({ replies: { evaluate: () => JSON.stringify({ verdict: "accurate", rationale: "matches evidence" }) } });
  const evaluator = createAgentEvaluatorPlugin({ backend: evalBackend });

  const before = listTransactions(db).length;
  const handlers = registerReadabilityTools({ db, projectDir, treeDir, backend, hbcPath, surface: "mcp", evaluator });
  const resolved = (await handlers.suggest_names({ target: { fn: 0 }, evaluate: "agent" })) as {
    suggestions: unknown[];
    evaluation?: { verdicts: readonly { verdict: string }[] };
  };
  assert.ok(resolved.evaluation !== undefined, "requesting evaluate:agent over MCP must return a report");
  assert.ok(!Object.keys(resolved.evaluation as object).includes("promote"), "the report carries judgements only");
  assert.equal(listTransactions(db).length, before, "an evaluation report must never touch the DB tier");

  // The `ui` surface never spawns an evaluator, even with the same plugin
  // wired and the same mode requested (section 1d.1).
  const uiHandlers = registerReadabilityTools({ db, projectDir, treeDir, backend, hbcPath, surface: "ui", evaluator });
  const uiResult = (await uiHandlers.suggest_names({ target: { fn: 0 }, evaluate: "agent" })) as { evaluation?: unknown };
  assert.equal(uiResult.evaluation, undefined, "the ui surface must never spawn an evaluator");
});
