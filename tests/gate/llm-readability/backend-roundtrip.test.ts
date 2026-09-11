// Spec 28 acceptance: a readability job round-trips through the SAME
// `WorkerBackend` boundary the gate already uses, with a fake backend standing
// in for Haiku (spec 28 section 9.1: no test ever calls the network). Green
// today -- this is the shape landing 1's HaikuBackend must produce.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBackend } from "../../../src/workers/backend.ts";
import type { WorkerBackend, WorkerJobRequest } from "../../../src/workers/backend.ts";
import { loadSkill } from "../../../src/readability/skills.ts";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { SKILLS_DIR, parseReadabilityResult } from "../../../src/readability/types.ts";

const skillsDir = join(repoRoot(), SKILLS_DIR);

function namesPayload(): string {
  return JSON.stringify({
    names: [
      { bindingId: { fn: 188, reg: 4 }, name: "sessionToken", confidence: "high", evidence: 'literal "auth.session.token"' },
      { bindingId: { fn: 188, reg: 7 }, name: "retryCount", confidence: "med", evidence: "incremented in the catch arm" },
    ],
    abstained: false,
  });
}

test("spec 28: a suggest-name job round-trips skill + context through a fake backend into proposals", async () => {
  const backend: WorkerBackend = new FakeBackend({ replies: { "suggest-name": () => namesPayload() } });
  const skill = loadSkill("hbc-name", skillsDir);
  const req: WorkerJobRequest = {
    kind: "suggest-name",
    prompt: `${skill.body}\n\n<context>`,
    context: { target: "fn188", source: "function f(){}", strings: ["auth.session.token"] },
  };
  const res = await backend.run(req);
  const parsed = parseReadabilityResult(res.text);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.equal(parsed.result.names.length, 2);
  assert.equal(parsed.result.abstained, false);
  const first = parsed.result.names[0];
  assert.ok(first !== undefined);
  assert.equal(first.name, "sessionToken");
  assert.equal(first.confidence, "high");
  assert.ok(first.evidence.length > 0, "a high-confidence proposal must cite evidence");
  // The prompt really did carry the skill; that is the only thing that makes a
  // run reproducible from the repo.
  assert.ok(req.prompt.startsWith("# hbc-name"), "the skill body leads the prompt");
});

test("spec 28: abstaining is a valid answer, not a failure", () => {
  const parsed = parseReadabilityResult(JSON.stringify({ names: [], abstained: true }));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.equal(parsed.result.abstained, true);
  assert.equal(parsed.result.names.length, 0);
  // An empty answer with no explicit flag is still an abstention.
  const implicit = parseReadabilityResult(JSON.stringify({ names: [] }));
  assert.ok(implicit.ok, implicit.ok ? "" : implicit.error);
  assert.equal(implicit.result.abstained, true);
});

test("spec 28: malformed model output is a rejected candidate, never a thrown run", () => {
  for (const bad of [
    "not json at all",
    "[]",
    '"a string"',
    JSON.stringify({ names: "nope" }),
    JSON.stringify({ names: [{ name: "x", confidence: "high", evidence: "e" }] }),
    JSON.stringify({ names: [{ bindingId: { fn: 1, reg: 2 }, name: "", confidence: "high", evidence: "e" }] }),
    JSON.stringify({ names: [{ bindingId: { fn: 1, reg: 2 }, name: "x", confidence: "certain", evidence: "e" }] }),
    JSON.stringify({ names: [], abstained: "yes" }),
  ]) {
    const parsed = parseReadabilityResult(bad);
    assert.equal(parsed.ok, false, `should have been rejected: ${bad}`);
    if (!parsed.ok) assert.ok(parsed.error.length > 0, "a rejection must say why");
  }
});

test("spec 28: an evidence-free proposal can never be high confidence", () => {
  const parsed = parseReadabilityResult(
    JSON.stringify({ names: [{ bindingId: { fn: 3, reg: 1 }, name: "userId", confidence: "high", evidence: "   " }] }),
  );
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  const only = parsed.result.names[0];
  assert.ok(only !== undefined);
  assert.equal(only.confidence, "low", "spec 28 section 1: no evidence means never auto-promotable");
});

test("spec 28: the fake backend records every call, which is what the cost/cache targets are measured through", async () => {
  const fake = new FakeBackend({ replies: { "suggest-name": () => namesPayload() } });
  await fake.run({ kind: "suggest-name", prompt: "p", context: { target: "fn1" } });
  await fake.run({ kind: "suggest-name", prompt: "p", context: { target: "fn2" } });
  assert.equal(fake.seen.length, 2);
  assert.equal(fake.id, "fake");
});
