// tests/artifact/stale.test.ts — A4 (docs/specs/10-artifact-format.md §7/§4.2):
// a stale ranges/index is a hard error, never a wrong answer. Full §4.2
// staleness matrix: ranges/render.hash mismatch, index.builtFor/bundle-or-
// producer mismatch, AND (docs/BUGS.md 2026-09-03 "overlayHash always null",
// now wired — `src/artifact/write.ts` + `src/artifact/service.ts`) the
// overlay-hash case §7 literally describes: "re-render with one overlay name
// changed WITHOUT regenerating ranges" — a `name set` changes the overlay
// store's content hash without touching `ranges.jsonl`/`render.hash` (a
// rename alone never reprints anything), so it is the ONE staleness case the
// render-hash check cannot see; this is the regression test for that gap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { splitProject } from "../../src/split/index.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { ArtifactService } from "../../src/artifact/service.ts";
import { ErrorCode, Hbc2jsError } from "../../src/errors.ts";
import { OverlayStore } from "../../src/name-overlay/store.ts";
import { regId } from "../../src/name-overlay/id.ts";

const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v96.hbc");
const bytes = readFileSync(FIXTURE_HBC);
const splitResult = splitProject(bytes, { moduleName: "04-for-loop-basic" });
const outDir = mkdtempSync(join(tmpdir(), "hbc2js-stale-"));
writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });

test.after(() => rmSync(outDir, { recursive: true, force: true }));

test("A4 a ranges/manifest render-hash mismatch throws E_STALE_RANGES from ArtifactService construction", () => {
  const staleDir = mkdtempSync(join(tmpdir(), "hbc2js-stale-copy-"));
  cpSync(outDir, staleDir, { recursive: true });
  const manifestPath = join(staleDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.render.hash = "0000000000000000000000000000000000000000000000000000000000000000";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  assert.throws(
    () => new ArtifactService(staleDir),
    (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_STALE_RANGES,
  );
  rmSync(staleDir, { recursive: true, force: true });
});

test("A4 queries succeed against the clean (non-stale) artifact", () => {
  const svc = new ArtifactService(outDir);
  assert.doesNotThrow(() => svc.fn(0));
});

test("A4 an index.builtFor/bundle mismatch throws E_STALE_INDEX from ArtifactService construction", () => {
  const staleDir = mkdtempSync(join(tmpdir(), "hbc2js-stale-builtfor-"));
  cpSync(outDir, staleDir, { recursive: true });
  const manifestPath = join(staleDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.index.builtFor.bundleSha256 = "0000000000000000000000000000000000000000000000000000000000000000";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  assert.throws(
    () => new ArtifactService(staleDir),
    (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_STALE_INDEX,
  );
  rmSync(staleDir, { recursive: true, force: true });
});

// --- overlay-hash half of §4.2 (docs/BUGS.md 2026-09-03 row, now wired) ---

test("A4 writeArtifact wires manifest.render.overlayHash from the overlay store's content", () => {
  const overlayDir = mkdtempSync(join(tmpdir(), "hbc2js-stale-overlay-"));
  const overlayPath = join(overlayDir, "names.json");
  const store = new OverlayStore({ bundle: "04-for-loop-basic" });
  store.now = () => "2026-09-03T00:00:00.000Z";
  store.setName(regId(0, 0), "userInput", { confidence: "high", evidence: "test", source: "human", gate: "passed" });
  store.save(overlayPath);

  const artifactDir = mkdtempSync(join(tmpdir(), "hbc2js-stale-overlay-artifact-"));
  writeArtifact({ bytes, splitResult, outDir: artifactDir, passes: {}, strictEnv: false, form: "flat", overlayStorePath: overlayPath });
  const manifest = JSON.parse(readFileSync(join(artifactDir, "manifest.json"), "utf8"));
  assert.equal(typeof manifest.render.overlayHash, "string");
  assert.notEqual(manifest.render.overlayHash, null);

  // Same content re-hashed at query time -> no staleness.
  assert.doesNotThrow(() => new ArtifactService(artifactDir, { overlayStorePath: overlayPath }));

  // Rename a register (store content changes) WITHOUT re-rendering the
  // artifact (ranges.jsonl/manifest.render.hash stay untouched, exactly as
  // §7's A4 describes) -> the overlay-hash mismatch is caught, specifically,
  // as E_STALE_INDEX.
  store.setName(regId(0, 0), "renamedInput", { confidence: "high", evidence: "test", source: "human", gate: "passed" });
  store.save(overlayPath);
  assert.throws(
    () => new ArtifactService(artifactDir, { overlayStorePath: overlayPath }),
    (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_STALE_INDEX && /overlay store content hash/.test(e.message),
  );

  // Re-writing the artifact (the fix — "run hbc2js render / re-write the
  // artifact") picks up the new overlay hash and clears the staleness.
  writeArtifact({ bytes, splitResult, outDir: artifactDir, passes: {}, strictEnv: false, form: "flat", overlayStorePath: overlayPath, overwrite: true });
  assert.doesNotThrow(() => new ArtifactService(artifactDir, { overlayStorePath: overlayPath }));

  rmSync(overlayDir, { recursive: true, force: true });
  rmSync(artifactDir, { recursive: true, force: true });
});

test("A4 an artifact built with no overlay in scope (overlayHash: null) never false-flags a store that appears later", () => {
  // outDir was written with no `overlayStorePath` — manifest.render.overlayHash
  // is null. Handing ArtifactService a real, non-empty overlay store path for
  // that same artifact must not throw: there is nothing to compare against.
  const overlayDir = mkdtempSync(join(tmpdir(), "hbc2js-stale-overlay-later-"));
  const overlayPath = join(overlayDir, "names.json");
  const store = new OverlayStore({ bundle: "04-for-loop-basic" });
  store.setName(regId(0, 0), "userInput", { confidence: "high", evidence: "test", source: "human", gate: "passed" });
  store.save(overlayPath);

  assert.doesNotThrow(() => new ArtifactService(outDir, { overlayStorePath: overlayPath }));
  rmSync(overlayDir, { recursive: true, force: true });
});
