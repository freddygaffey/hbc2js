// tests/artifact/stale.test.ts — A4 (docs/specs/10-artifact-format.md §7/§4.2):
// a stale ranges/index is a hard error, never a wrong answer. Full scope
// (§7's "re-render with one overlay name changed") needs the overlay's
// render.overlayHash wired into `writeArtifact`, which is not yet done
// (docs/BUGS.md P2.1-overlay-hash-not-wired) — this test covers the part
// that IS wired: a `manifest.render.hash`/`ranges.jsonl` mismatch, however it
// arose, is refused by every query path.
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
