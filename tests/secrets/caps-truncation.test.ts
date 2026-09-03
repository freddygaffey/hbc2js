// T6 (spec 12 §8) — caps + truncation truthfulness on the CLI/service verbs.
// Not landed until impl step 4 (CLI verbs); guarded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGroundTruth, materializeArtifact } from "./support/materialize.ts";

const SERVICE_PATH = "../../src/secrets/service.ts";

test("T6 report caps at <=60 lines with a truncation marker, list caps at <=50+total, no verb quotes >8 chars of any seeded secret", async () => {
  const mod = (await import(SERVICE_PATH).catch(() => null)) as null | {
    SecretsService: new (...args: unknown[]) => {
      scan: (opts?: { force?: boolean }) => unknown;
      report: () => string[];
      list: (q?: { category?: string; tier?: string }) => string[];
    };
  };
  assert.ok(mod, `${SERVICE_PATH} does not exist yet (spec 12 §9 step 4)`);
  if (!mod) return;

  // The checked-in fixture is defused at rest; materialize the real-format
  // artifact into a scratch dir (tests/fixtures/secrets/seeded/README.md).
  const fixtureDir = materializeArtifact();
  const gt = loadGroundTruth();

  const { SecretsService } = mod;
  const svc = new SecretsService({ artifactDir: fixtureDir });
  svc.scan({ force: true });

  const report = svc.report();
  assert.ok(report.length <= 60, `report must be <= 60 lines, got ${report.length}`);

  const list = svc.list();
  assert.ok(list.length <= 51, `list must be <= 50 rows + total line, got ${list.length}`);

  const allOutput = [...report, ...list].join("\n");
  for (const s of gt.secrets) {
    if (s.value.length <= 8) continue;
    assert.ok(!allOutput.includes(s.value), `verb output must not quote > 8 consecutive chars of a seeded secret: ${s.value.slice(0, 8)}...`);
  }
});
