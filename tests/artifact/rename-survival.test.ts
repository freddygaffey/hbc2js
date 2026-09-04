// tests/artifact/rename-survival.test.ts — A5 (docs/specs/10-artifact-format.md
// §7): the point of binding ids. Build an artifact, `name set` on a register,
// re-render (a fresh `writeArtifact` write against the same overlay store) —
// the SEMANTIC index files stay byte-identical (`manifest.index.semanticHash`
// unchanged) and `who-calls`/`fn` id-based answers are id-identical before and
// after; only `overlayName` (and, once render applies the overlay, `file:line`)
// may differ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { splitProject } from "../../src/split/index.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { ArtifactService } from "../../src/artifact/service.ts";
import { OverlayStore } from "../../src/name-overlay/store.ts";
import { regId } from "../../src/name-overlay/id.ts";

const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v96.hbc");
const bytes = readFileSync(FIXTURE_HBC);
const splitResult = splitProject(bytes, { moduleName: "04-for-loop-basic" });

test("A5 rename survives across a re-render: semantic index unchanged, id-based query answers unchanged, only overlayName differs", () => {
  const overlayDir = mkdtempSync(join(tmpdir(), "hbc2js-rename-survival-overlay-"));
  const overlayPath = join(overlayDir, "names.json");
  const artifactDir = mkdtempSync(join(tmpdir(), "hbc2js-rename-survival-artifact-"));

  // Build #1: no name set yet.
  const written1 = writeArtifact({ bytes, splitResult, outDir: artifactDir, passes: {}, strictEnv: false, form: "flat", overlayStorePath: overlayPath });
  const semanticFiles = ["functions.jsonl", "calls.jsonl", "calls-resolved.jsonl", "strings.json", "string-uses.jsonl", "globals.jsonl", "native.jsonl", "modules.json"] as const;
  const before = new Map(semanticFiles.map((f) => [f, readFileSync(join(artifactDir, "index", f), "utf8")]));

  const svcBefore = new ArtifactService(artifactDir, { overlayStorePath: overlayPath });
  const targetFn = 0;
  const beforeFn = svcBefore.fn(targetFn);
  const beforeWhoCalls = svcBefore.whoCalls(targetFn, { all: true });
  const beforeCallsFrom = svcBefore.callsFrom(targetFn, { all: true });
  assert.equal(beforeFn.overlayName, null);

  // `name set` on a register of that function.
  const store = new OverlayStore({ bundle: "04-for-loop-basic" });
  store.setName(regId(targetFn, 0), "renamedReg", { confidence: "high", evidence: "test", source: "human", gate: "passed" });
  store.save(overlayPath);

  // Re-render: a fresh writeArtifact write, same bytes/splitResult (the
  // semantic layer never reads the overlay — §0's whole point).
  const written2 = writeArtifact({ bytes, splitResult, outDir: artifactDir, passes: {}, strictEnv: false, form: "flat", overlayStorePath: overlayPath, overwrite: true });
  const after = new Map(semanticFiles.map((f) => [f, readFileSync(join(artifactDir, "index", f), "utf8")]));

  for (const f of semanticFiles) assert.equal(after.get(f), before.get(f), `${f} changed across a rename-only re-render`);
  assert.equal(written2.manifest.index.semanticHash, written1.manifest.index.semanticHash);

  const svcAfter = new ArtifactService(artifactDir, { overlayStorePath: overlayPath });
  const afterFn = svcAfter.fn(targetFn);
  const afterWhoCalls = svcAfter.whoCalls(targetFn, { all: true });
  const afterCallsFrom = svcAfter.callsFrom(targetFn, { all: true });

  // id-based content is unchanged; overlayName is the only difference.
  assert.deepEqual(
    afterWhoCalls.rows.map((r) => ({ fn: r.fn, kind: r.kind })),
    beforeWhoCalls.rows.map((r) => ({ fn: r.fn, kind: r.kind })),
  );
  assert.deepEqual(
    afterCallsFrom.rows.map((r) => ({ fn: r.fn, kind: r.kind })),
    beforeCallsFrom.rows.map((r) => ({ fn: r.fn, kind: r.kind })),
  );
  assert.equal(afterFn.name, beforeFn.name);
  assert.equal(afterFn.module, beforeFn.module);
  assert.equal(afterFn.params, beforeFn.params);
  assert.equal(afterFn.overlayName, "renamedReg");

  rmSync(overlayDir, { recursive: true, force: true });
  rmSync(artifactDir, { recursive: true, force: true });
});
