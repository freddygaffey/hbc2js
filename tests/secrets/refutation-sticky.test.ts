// T7 (spec 12 §8) — refutation is sticky. Depends on store integration
// (step 3); guarded.
//
// `ProjectService`'s real constructor is `(artifactDir, artifact)` (not the
// `{artifactDir}` options-object shape this test previously called) — it
// reads `artifact.manifest.bundle.sha256` at construction time, so it needs
// a real `ArtifactService` over a real artifact directory, same as
// tests/project/service.test.ts. `SecretsService` and `ProjectService` must
// point at the SAME directory root, so a real artifact is built first (via
// `writeArtifact` on a small construct fixture, cheap) and then
// `materializeArtifact` overwrites that artifact's `index/strings.json` +
// `index/string-uses.jsonl` in place with the seeded ground-truth secrets.
// The test also previously called invented `refute(id, note)`/`history(id)`
// methods that do not exist on `ProjectService`; the real write verb is
// `setFindingStatus(rid, "refuted", evidence, prov)` (spec 11 §3.1's
// `project finding set-status`) and the real read is `finding(rid).status`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { materializeArtifact } from "./support/materialize.ts";

const SERVICE_PATH = "../../src/secrets/service.ts";
const PROJECT_PATH = "../../src/project/service.ts";
const ARTIFACT_PATH = "../../src/artifact/service.ts";

const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "01-if-else-chain", "v94.hbc");

test("T7 refuting a finding then re-scanning does not resurrect it; refuted chain stays intact", async () => {
  const secretsMod = (await import(SERVICE_PATH).catch(() => null)) as null | {
    SecretsService: new (...args: unknown[]) => {
      scan: (opts?: { force?: boolean }) => unknown;
      list: (q?: { category?: string; tier?: string }) => { id: string; status: string; target: string }[];
    };
  };
  const projectMod = (await import(PROJECT_PATH).catch(() => null)) as null | {
    ProjectService: new (...args: unknown[]) => {
      save: () => void;
      setFindingStatus: (
        rid: string,
        to: string,
        evidence: readonly { ref: string; role: string; note?: string }[],
        prov: { source: string; who: string },
      ) => unknown;
      finding: (rid: string) => { status: string } | null;
    };
  };
  const artifactMod = (await import(ARTIFACT_PATH).catch(() => null)) as null | {
    ArtifactService: new (artifactDir: string) => unknown;
  };
  assert.ok(secretsMod, `${SERVICE_PATH} does not exist yet (spec 12 §9 step 3)`);
  assert.ok(projectMod, `${PROJECT_PATH} does not exist yet (spec 11 §7)`);
  assert.ok(artifactMod, `${ARTIFACT_PATH} does not exist yet`);
  if (!secretsMod || !projectMod || !artifactMod) return;

  // Real artifact (manifest.json + full index/) from a small construct
  // fixture, same recipe as tests/project/service.test.ts.
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-secrets-refutation-"));
  try {
    const bytes = readFileSync(FIXTURE_HBC);
    const splitResult = splitProject(bytes, { moduleName: "index.hbc" });
    writeArtifact({ bytes, splitResult, outDir: dir, passes: {}, strictEnv: false, form: "flat" });

    // The checked-in secrets fixture is defused at rest; materialize the
    // real-format ground-truth strings/uses INTO this same artifact dir
    // (tests/fixtures/secrets/seeded/README.md), overwriting only
    // index/strings.json + index/string-uses.jsonl.
    materializeArtifact(undefined, dir);

    const { SecretsService } = secretsMod;
    const { ProjectService } = projectMod;
    const { ArtifactService } = artifactMod;

    const artifact = new ArtifactService(dir);
    // `SecretsService` writes ONLY `project/findings.jsonl` directly (its
    // module header); `ProjectService.save()` establishes the full
    // §2.2 file set (`project.json`/comments/tags/bookmarks/findings) once
    // up front so the later real `ProjectService` load below (which
    // requires the exact file set) succeeds.
    new ProjectService(dir, artifact).save();

    const svc = new SecretsService({ artifactDir: dir });
    svc.scan({ force: true });
    const before = svc.list();
    assert.ok(before.length > 0, "seeded fixture must produce at least one finding");
    const target = before[0]!;

    // Reload: this instance's store must reflect the findings the scan just
    // wrote to disk.
    const project = new ProjectService(dir, artifact);
    project.setFindingStatus(target.id, "refuted", [{ ref: target.target, role: "context", note: "docs example key" }], {
      source: "human",
      who: "fred",
    });

    const refutedNow = project.finding(target.id);
    assert.equal(refutedNow?.status, "refuted", "finding must read back as refuted immediately after the transition");

    svc.scan({ force: true });
    const after = svc.list();
    const stillOpen = after.find((f) => f.id === target.id && f.status === "open");
    assert.equal(stillOpen, undefined, "refuted finding must not be resurrected by a re-scan");

    // The refuted status must survive the re-scan (§4.3 R1: store-driven,
    // not cache-driven, suppression) — reload once more to prove it is what
    // is actually on disk, not just in-memory state from before the scan.
    const projectAfter = new ProjectService(dir, artifact);
    const stillRefuted = projectAfter.finding(target.id);
    assert.equal(stillRefuted?.status, "refuted", "refuted record must remain in the status chain after a re-scan");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
