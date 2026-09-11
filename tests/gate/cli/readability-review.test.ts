// docs/specs/28-llm-readability.md section 9.7: the `readability review`
// verb, landing 5. Exercised via child process (spawnSync with an argv
// array, never a shell string). The suggestion queue is pre-populated
// directly through `OverlayStore` (the same JSON sidecar `name llm-fill`
// itself writes) rather than depending on a specific backend's naming
// output, so this test is about the CLI verb, not about what any one
// backend happens to propose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { OverlayStore, regId } from "../../../src/name-overlay/index.ts";
import { cacheKey, resolveHaikuConfig } from "../../../src/readability/types.ts";
import { loadSkill } from "../../../src/readability/skills.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const HBC_SRC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v94.hbc");

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", shell: false });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withTempHbc<T>(fn: (hbc: string, store: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-cli-review-"));
  try {
    const hbc = join(dir, "v94.hbc");
    copyFileSync(HBC_SRC, hbc);
    return fn(hbc, `${hbc}.names.json`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readability review without <input.hbc> is a usage error (exit 2)", () => {
  const r = runCli(["readability", "review"]);
  assert.equal(r.status, 2, r.stderr);
});

test("readability review over an empty store reviews zero suggestions", () => {
  withTempHbc((hbc) => {
    const r = runCli(["readability", "review", hbc, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const summary = JSON.parse(r.stdout) as { reviewed: number; adversarial: boolean; flagged: number };
    assert.deepEqual(summary, { reviewed: 0, adversarial: false, flagged: 0 });
  });
});

test("readability review lists the suggestion queue, and --adversarial runs without crashing on a non-JSON backend reply", () => {
  withTempHbc((hbc, store) => {
    const overlay = new OverlayStore({ bundle: hbc });
    overlay.setName(regId(0, 9), "trustedInternalCounter", { confidence: "high", evidence: "e", source: "llm", gate: "passed" });
    overlay.save(store);

    const plain = runCli(["readability", "review", hbc, "--store", store, "--json"]);
    assert.equal(plain.status, 0, plain.stderr);
    const plainSummary = JSON.parse(plain.stdout) as { reviewed: number; adversarial: boolean; flagged: number };
    assert.equal(plainSummary.reviewed, 1);
    assert.equal(plainSummary.adversarial, false);
    assert.equal(plainSummary.flagged, 0, "no recheck ran, so nothing can be flagged");

    // `--adversarial` with the heuristic backend (which never emits the
    // `{verdict,rationale}` JSON contract) must still run to completion: a
    // malformed evaluator reply is a low-information "not misleading"
    // verdict (`evaluate.ts`'s `parseVerdictResponse`), never a crash.
    const adversarial = runCli(["readability", "review", hbc, "--store", store, "--backend", "heuristic", "--adversarial", "--json"]);
    assert.equal(adversarial.status, 0, adversarial.stderr);
    const adversarialSummary = JSON.parse(adversarial.stdout) as { reviewed: number; adversarial: boolean; flagged: number };
    assert.equal(adversarialSummary.reviewed, 1);
    assert.equal(adversarialSummary.adversarial, true);
    assert.equal(adversarialSummary.flagged, 0, "the heuristic backend never emits a misleading verdict on its own prose");

    const stored = JSON.parse(readFileSync(store, "utf8")) as { records: readonly { name: string; confidence: string }[] };
    assert.equal(stored.records.some((r) => r.name === "trustedInternalCounter" && r.confidence === "high"), true, "an unflagged suggestion is untouched by --adversarial");
  });
});

test("readability review --adversarial demotes a misleading name flagged via --security-relevant, using a replay recording", () => {
  withTempHbc((hbc, store) => {
    const overlay = new OverlayStore({ bundle: hbc });
    overlay.setName(regId(0, 9), "trustedInternalCounter", { confidence: "high", evidence: "e", source: "llm", gate: "passed" });
    overlay.save(store);

    // A recording keyed exactly the way `ReplayBackend`/`HaikuBackend` derive
    // it (`cacheKey`), for the ONE `adversarial-recheck` call this pass makes.
    const skill = loadSkill("hbc-adversarial", join(repoRoot(), "skills"));
    const model = resolveHaikuConfig(process.env).model;
    const context = JSON.stringify({ evidence: "e", proposedName: "trustedInternalCounter", targetId: "reg:0:9" }, ["evidence", "proposedName", "targetId"].sort());
    const key = cacheKey({ kind: "adversarial-recheck", skillId: "hbc-adversarial", skillVersion: skill.version, model, body: "", context });
    const recordingPath = `${store}.recording.json`;
    writeFileSync(
      recordingPath,
      JSON.stringify({ [key]: { text: JSON.stringify({ verdict: "misleading", rationale: "asserts trust the evidence never shows" }) } }),
    );

    const r = runCli([
      "readability",
      "review",
      hbc,
      "--store",
      store,
      "--backend",
      "replay",
      "--recording",
      recordingPath,
      "--security-relevant",
      "0:9",
      "--adversarial",
      "--json",
    ]);
    assert.equal(r.status, 0, r.stderr);
    const summary = JSON.parse(r.stdout) as { reviewed: number; flagged: number };
    assert.equal(summary.reviewed, 1);
    assert.equal(summary.flagged, 1, "the planted misleading verdict must demote the suggestion");

    const stored = JSON.parse(readFileSync(store, "utf8")) as { records: readonly { name: string; confidence: string; evidence: string }[] };
    const active = stored.records.find((r2) => r2.name === "trustedInternalCounter");
    assert.equal(active?.confidence, "low");
    assert.match(active?.evidence ?? "", /^\[flagged: misleading\]/);
  });
});

