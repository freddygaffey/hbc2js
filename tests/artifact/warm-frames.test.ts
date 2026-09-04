// tests/artifact/warm-frames.test.ts — cold-start regression (docs/UI.md
// "Cold start"): `ArtifactService.warmFrames()` runs the whole-bundle
// live-frame computation (`analyseModule` + `rawFrames`) proactively, off a
// request's own critical path, without ever running `analyseModule` twice —
// even when a request races the prewarm and reaches the live-frame path
// (`renderFn`/`list`/`context`, all funnelled through the same private
// `ensureFrames`) before `warmFrames`'s own `setImmediate` fires.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { splitProject } from "../../src/split/index.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { ArtifactService } from "../../src/artifact/service.ts";

const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v96.hbc");
const bytes = readFileSync(FIXTURE_HBC);
const splitResult = splitProject(bytes, { moduleName: "04-for-loop-basic" });

function buildArtifact(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-warm-frames-"));
  writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
  return outDir;
}

test("warmFrames populates the live frames once; renderFn afterwards does not re-run analyseModule", async () => {
  const outDir = buildArtifact();
  try {
    const svc = new ArtifactService(outDir, { hbc: FIXTURE_HBC });
    assert.equal(svc.warmAnalyseCount, 0);
    await svc.warmFrames();
    assert.equal(svc.warmAnalyseCount, 1, "warmFrames must run analyseModule exactly once");
    const rendered = svc.renderFn(0);
    assert.ok(rendered !== null, "fn 0 must have a live frame after warmFrames");
    assert.equal(svc.warmAnalyseCount, 1, "a request after warmFrames must reuse the warmed analysis, not recompute it");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("warmFrames is a no-op once frames are already computed (e.g. a request beat it there)", async () => {
  const outDir = buildArtifact();
  try {
    const svc = new ArtifactService(outDir, { hbc: FIXTURE_HBC });
    const rendered = svc.renderFn(0); // synchronous request-path computation, before any warm call
    assert.ok(rendered !== null);
    assert.equal(svc.warmAnalyseCount, 1);
    await svc.warmFrames();
    assert.equal(svc.warmAnalyseCount, 1, "warmFrames must not recompute an already-warm analysis");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("concurrent warmFrames callers share the same in-flight computation", async () => {
  const outDir = buildArtifact();
  try {
    const svc = new ArtifactService(outDir, { hbc: FIXTURE_HBC });
    const [a, b] = [svc.warmFrames(), svc.warmFrames()];
    await Promise.all([a, b]);
    assert.equal(svc.warmAnalyseCount, 1, "two concurrent warmFrames calls must not run analyseModule twice");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("warmFrames is a no-op (resolves immediately, never analyses) without --hbc", async () => {
  const outDir = buildArtifact();
  try {
    const svc = new ArtifactService(outDir); // no hbc option
    await svc.warmFrames();
    assert.equal(svc.warmAnalyseCount, 0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
