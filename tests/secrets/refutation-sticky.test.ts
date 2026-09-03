// T7 (spec 12 §8) — refutation is sticky. Depends on store integration
// (step 3); guarded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { materializeArtifact } from "./support/materialize.ts";

const SERVICE_PATH = "../../src/secrets/service.ts";
const PROJECT_PATH = "../../src/project/service.ts";

test("T7 refuting a finding then re-scanning does not resurrect it; refuted chain stays intact", async () => {
  const secretsMod = (await import(SERVICE_PATH).catch(() => null)) as null | {
    SecretsService: new (...args: unknown[]) => {
      scan: (opts?: { force?: boolean }) => unknown;
      list: (q?: { category?: string; tier?: string }) => { id: string; status: string; target: string }[];
    };
  };
  const projectMod = (await import(PROJECT_PATH).catch(() => null)) as null | {
    ProjectService: new (...args: unknown[]) => {
      refute: (id: string, note: string) => unknown;
      history: (id: string) => { status: string }[];
    };
  };
  assert.ok(secretsMod, `${SERVICE_PATH} does not exist yet (spec 12 §9 step 3)`);
  assert.ok(projectMod, `${PROJECT_PATH} does not exist yet (spec 11 §7)`);
  if (!secretsMod || !projectMod) return;

  // The checked-in fixture is defused at rest; materialize the real-format
  // artifact into a scratch dir (tests/fixtures/secrets/seeded/README.md).
  const fixtureDir = materializeArtifact();
  const { SecretsService } = secretsMod;
  const { ProjectService } = projectMod;

  const svc = new SecretsService({ artifactDir: fixtureDir });
  svc.scan({ force: true });
  const before = svc.list();
  assert.ok(before.length > 0, "seeded fixture must produce at least one finding");
  const target = before[0]!;

  const project = new ProjectService({ artifactDir: fixtureDir });
  project.refute(target.id, "docs example key");

  svc.scan({ force: true });
  const after = svc.list();
  const stillOpen = after.find((f) => f.id === target.id && f.status === "open");
  assert.equal(stillOpen, undefined, "refuted finding must not be resurrected by a re-scan");

  const hist = project.history(target.id);
  assert.ok(hist.some((h) => h.status === "refuted"), "refuted record must remain in the history chain");
});
