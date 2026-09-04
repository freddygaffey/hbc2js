// tests/ui-server/warm-frames.test.ts — cold-start regression (docs/UI.md
// "Cold start", brief ui-server-warm): `startUiServer` prewarms the
// whole-bundle live-frame analysis right after `listen` by default, and
// `prewarm: false` (CLI `--no-prewarm`) skips it. A request landing during
// warm-up must never trigger a SECOND `analyseModule` pass — asserted via
// `ArtifactService.warmAnalyseCount` (never a literal-output compare on a
// shared fixture, CLAUDE.md / docs/CONSOLIDATION.md §B testing rules).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { splitProject } from "../../src/split/index.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { startUiServer } from "../../src/ui-server/server.ts";

const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v96.hbc");
const bytes = readFileSync(FIXTURE_HBC);
const splitResult = splitProject(bytes, { moduleName: "04-for-loop-basic" });

function buildArtifact(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-ui-warm-"));
  writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
  return outDir;
}

async function untilTrue(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("startUiServer prewarms the live-frame analysis by default (--hbc given)", async () => {
  const outDir = buildArtifact();
  const h = await startUiServer({ projectDir: outDir, hbc: FIXTURE_HBC, port: 0, host: "127.0.0.1", workers: false });
  try {
    await untilTrue(() => h.ctx.resources.artifact.warmAnalyseCount >= 1);
    assert.equal(h.ctx.resources.artifact.warmAnalyseCount, 1);
  } finally {
    await h.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("startUiServer({prewarm:false}) (CLI --no-prewarm) never warms the analysis on its own", async () => {
  const outDir = buildArtifact();
  const h = await startUiServer({ projectDir: outDir, hbc: FIXTURE_HBC, port: 0, host: "127.0.0.1", workers: false, prewarm: false });
  try {
    // Give the (absent) prewarm scheduler every chance to fire before asserting the negative.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(h.ctx.resources.artifact.warmAnalyseCount, 0);
  } finally {
    await h.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("a request racing the prewarm never starts a second analysis", async () => {
  const outDir = buildArtifact();
  const h = await startUiServer({ projectDir: outDir, hbc: FIXTURE_HBC, port: 0, host: "127.0.0.1", workers: false });
  try {
    // Reach the live-frame path directly and immediately (synchronously, in
    // the same tick `listen`'s callback ran in) — this is the race: it beats
    // the prewarm's own `setImmediate` there deliberately.
    const rendered = h.ctx.resources.artifact.renderFn(0);
    assert.ok(rendered !== null);
    // Let the scheduled prewarm actually fire; it must find frames already
    // warm and do nothing further.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.ctx.resources.artifact.warmAnalyseCount, 1, "only one analyseModule pass, regardless of which caller (request or prewarm) won the race");
  } finally {
    await h.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});
