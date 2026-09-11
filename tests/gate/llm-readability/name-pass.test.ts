// Spec 28 landing 1: `runNamePass`, the shared per-target loop (section 1b,
// NAMES only) both the batch CLI and the runner drive. Exercised end to end
// with `FakeBackend` -- the only backend the gate ever calls -- over a small
// construct fixture, which is what proves the pipeline works without needing
// the held-out app's (unavailable) recorded run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { parseForDecompile } from "../../../src/decompile.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { NameService, OverlayStore, regId, shortForm } from "../../../src/name-overlay/index.ts";
import { FakeBackend } from "../../../src/workers/backend.ts";
import { runNamePass, namedCount } from "../../../src/readability/name-pass.ts";
import type { NamePassTarget } from "../../../src/readability/name-pass.ts";

const FIXTURE = "04-for-loop-basic";

function analysisFor(name: string): ReturnType<typeof analyseModule> {
  const bytes = new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, "v94.hbc")));
  return analyseModule(parseForDecompile(bytes, {}).module, { strictEnv: true });
}

function svc(): NameService {
  return new NameService(analysisFor(FIXTURE), new OverlayStore({ bundle: FIXTURE }));
}

function target(fn: number, reg: number, source: string): NamePassTarget {
  const id = regId(fn, reg);
  return { bindingId: id, kind: "suggest-name", context: { target: shortForm(id), fn, reg, source } };
}

function nameReply(fn: number, reg: number, name: string, confidence: "low" | "med" | "high" = "high"): string {
  return JSON.stringify({
    names: [{ bindingId: { fn, reg }, name, confidence, evidence: `evidence for ${name}` }],
    abstained: false,
  });
}

test("runNamePass: a proposal that passes the gate is written, and the apply-then-revert backstop PASSes", async () => {
  const service = svc();
  const before = service.render().code;
  const backend = new FakeBackend({ replies: { "suggest-name": () => nameReply(0, 9, "loopCount") } });
  const targets = [target(0, 9, "function f0(){ for (let r9=0;r9<10;r9++) {} }")];
  const result = await runNamePass(targets, { backend, service });
  assert.equal(result.equiv.verdict, "PASS");
  assert.equal(result.equiv.scope, "name");
  assert.equal(namedCount(result.outcomes), 1);
  assert.equal(service.getName(regId(0, 9))?.name, "loopCount");
  // The overlay is the ONLY thing that changed; a render right now differs
  // from `before` (the name shows), which is expected -- the backstop proved
  // that REVERTING would restore `before` exactly, not that nothing changed.
  assert.notEqual(service.render().code, before);
});

test("runNamePass: abstention and malformed output are recorded, never thrown, and write nothing", async () => {
  const service = svc();
  const backend = new FakeBackend({
    replies: {
      "suggest-name": (req) => (req.context["reg"] === 9 ? JSON.stringify({ names: [], abstained: true }) : "not json"),
    },
  });
  const targets = [target(0, 9, "s1"), target(0, 12, "s2")];
  const result = await runNamePass(targets, { backend, service });
  assert.equal(namedCount(result.outcomes), 0);
  assert.equal(result.outcomes[0]?.reason, "abstained");
  assert.equal(result.outcomes[1]?.reason, "parse-error");
  assert.equal(result.equiv.verdict, "PASS", "nothing was written, so the backstop trivially passes");
});

test("runNamePass: the budget stop happens between targets, never mid-write", async () => {
  const service = svc();
  const backend = new FakeBackend({
    replies: { "suggest-name": (req) => nameReply(0, Number(req.context["reg"]), "x") },
  });
  const targets = [target(0, 9, "s1"), target(0, 12, "s2")];
  // Each call costs 100 tokens (50 in defaultReply-shaped cost below); a
  // budget smaller than two calls' worth must stop after the first.
  const result = await runNamePass(targets, { backend, service, budgetTokens: 1 });
  assert.equal(result.stoppedAtBudget, true);
  // The first target still ran (a real backend call costs > 0 tokens, so the
  // pre-loop check only fires before target #2).
  assert.equal(result.outcomes.some((o) => o.reason === "budget-stopped"), true);
});

test("runNamePass: a name the reuse gate refuses is not written, and does not fail the batch", async () => {
  const service = svc();
  // r9 is a real, nameable register (04-for-loop-basic's loop counter);
  // "return" is a reserved word the gate must refuse unconditionally.
  const backend = new FakeBackend({ replies: { "suggest-name": () => nameReply(0, 9, "return") } });
  const result = await runNamePass([target(0, 9, "s")], { backend, service });
  assert.equal(namedCount(result.outcomes), 0);
  assert.equal(result.outcomes[0]?.reason, "gate-refused");
  assert.equal(service.getName(regId(0, 9)), null);
});

test("runNamePass: landing 5's adversarial re-check demotes a misleading name on a securityRelevant target, and the backstop still PASSes on the demoted state", async () => {
  const service = svc();
  const backend = new FakeBackend({ replies: { "suggest-name": () => nameReply(0, 9, "trustedInternalCounter", "high") } });
  const adversarialBackend = new FakeBackend({
    replies: { "adversarial-recheck": () => JSON.stringify({ verdict: "misleading", rationale: "asserts trust the evidence never shows" }) },
  });
  const t: NamePassTarget = { ...target(0, 9, "s"), securityRelevant: true };
  const result = await runNamePass([t], { backend, service, adversarial: { backend: adversarialBackend } });

  assert.equal(namedCount(result.outcomes), 1, "the name is still written -- flagged, not discarded");
  assert.equal(result.outcomes[0]?.flagged, true);
  assert.equal(result.outcomes[0]?.proposal?.confidence, "low", "a misleading verdict demotes below auto-promote");
  assert.match(result.outcomes[0]?.proposal?.evidence ?? "", /^\[flagged: misleading\]/);

  const record = service.getName(regId(0, 9));
  assert.equal(record?.confidence, "low");
  assert.match(record?.evidence ?? "", /^\[flagged: misleading\]/);
  assert.equal(result.equiv.verdict, "PASS", "the backstop restores the DEMOTED record, not the pre-recheck one");
});

test("runNamePass: the adversarial re-check never runs when opts.adversarial is not wired", async () => {
  const service = svc();
  const backend = new FakeBackend({ replies: { "suggest-name": () => nameReply(0, 9, "trustedInternalCounter", "high") } });
  const t: NamePassTarget = { ...target(0, 9, "s"), securityRelevant: true };
  const result = await runNamePass([t], { backend, service });
  assert.equal(result.outcomes[0]?.flagged, undefined);
  assert.equal(service.getName(regId(0, 9))?.confidence, "high");
});
