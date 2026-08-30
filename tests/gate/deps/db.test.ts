// docs/DECISIONS.md D17b — signature-DB layering: project-local -> user
// cache -> shared, first hit wins, one file format across all three.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSharedDbDir, loadSignatures, resolveDbLayers, writeSignature } from "../../../src/deps/db.ts";
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";

function makeDb(overrides: Partial<SigDbFile> = {}): SigDbFile {
  return {
    schema: 2,
    package: "some-pkg",
    version: "1.0.0",
    hbcVersion: 94,
    totalFunctions: 1,
    rawFunctionCount: 1,
    subtractedBaselines: [],
    functions: [{ index: 0, name: "f", paramCount: 0, instrCount: 10, exactHash: "a".repeat(24), fuzzyHash: "b".repeat(24), stringSetHash: "c".repeat(24), stringCount: 0 }],
    modules: [],
    toolchainBaseline: false,
    provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: 94, hermescRnEra: null, repoCommit: null, builtAt: new Date().toISOString() },
    ...overrides,
  };
}

test("resolveDbLayers: project -> user -> shared, in that order, and --no-shared-db drops the shared layer", () => {
  const layers = resolveDbLayers({ outDir: "/tmp/out" });
  assert.equal(layers.length, 3);
  assert.equal(layers[0]!.name, "project");
  assert.equal(layers[1]!.name, "user");
  assert.equal(layers[2]!.name, "shared");
  assert.equal(layers[2]!.dir, defaultSharedDbDir());

  const noShared = resolveDbLayers({ outDir: "/tmp/out", noSharedDb: true });
  assert.equal(noShared.length, 2);
  assert.ok(noShared.every((l) => l.name !== "shared"));
});

test("--sigdb overrides the project-local directory outright", () => {
  const layers = resolveDbLayers({ outDir: "/tmp/out", sigdb: "/custom/sigdb" });
  assert.equal(layers[0]!.dir, "/custom/sigdb");
});

test("loadSignatures: a project-local entry shadows a shared entry for the same package@version+hbcVersion", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "hbc2js-deps-db-project-"));
  const sharedDir = mkdtempSync(join(tmpdir(), "hbc2js-deps-db-shared-"));
  try {
    const shared = makeDb({ totalFunctions: 999 }); // "stale" shared copy
    const project = makeDb({ totalFunctions: 1 }); // "confirmed" project-local copy
    writeSignature(sharedDir, shared);
    writeSignature(projectDir, project);

    const loaded = loadSignatures([
      { name: "project", dir: projectDir },
      { name: "shared", dir: sharedDir },
    ]);
    assert.equal(loaded.length, 1, "expected exactly one entry after dedup");
    assert.equal(loaded[0]!.layer, "project");
    assert.equal(loaded[0]!.file.totalFunctions, 1);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(sharedDir, { recursive: true, force: true });
  }
});

test("writeSignature: a toolchainBaseline file lands under _baselines/ and updates index.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-deps-db-baseline-"));
  try {
    const baseline = makeDb({ package: "metro-toolchain-empty", toolchainBaseline: true });
    const path = writeSignature(dir, baseline);
    assert.match(path, /_baselines[/\\]metro-toolchain-empty@1\.0\.0__hbc94\.json$/);

    const loaded = loadSignatures([{ name: "shared", dir }]);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.file.toolchainBaseline, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
