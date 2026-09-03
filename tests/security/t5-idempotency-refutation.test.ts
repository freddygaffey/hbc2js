// tests/security/t5-idempotency-refutation.test.ts — T5 (spec 13 §10, §6.3,
// §7). Re-run adapter with identical scan-state -> 0 new active records;
// refute one finding, re-run -> stays refuted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeps } from "../../src/deps/index.ts";
import { loadOsvSlice, matchOsv, OsvService, moduleEvidenceResolver } from "../../src/security/osv-adapter.ts";
import { repoRoot } from "../support/paths.ts";

const FIXTURE_DIR = join(repoRoot(), "tests", "fixtures", "security", "vuln-app");

test("T5: idempotent re-run adds 0 new active records; a refuted finding stays refuted across re-runs", async () => {
  const { report } = await runDeps(join(FIXTURE_DIR, "v96.hbc"), { sigdb: join(FIXTURE_DIR, "sigdb"), noSharedDb: true, offline: true });
  const slice = loadOsvSlice();
  const matches = matchOsv(report, slice);
  assert.ok(matches.length > 0);

  const scratchDir = mkdtempSync(join(tmpdir(), "hbc2js-osv-t5-"));
  try {
    const svc = new OsvService({ projectDir: scratchDir });
    const opts = { dbDate: slice._retrieved, runId: "t5-run-1", reportHash: "deadbeef" };
    const first = svc.writeMatches(matches, report, opts);
    assert.ok(first.new > 0);

    const second = svc.writeMatches(matches, report, { ...opts, runId: "t5-run-2" });
    assert.equal(second.new, 0, "identical scan-state re-run must add 0 new active records");
    assert.equal(second.cached, first.new, "the previously-written findings should all be recognised as unchanged");

    const someFinding = svc.allFindings()[0]!;
    const resolver = moduleEvidenceResolver(report);
    svc.refute(someFinding.rid, resolver);
    assert.equal(svc.statusOf(someFinding.rid), "refuted");

    const third = svc.writeMatches(matches, report, { ...opts, runId: "t5-run-3" });
    assert.equal(svc.statusOf(someFinding.rid), "refuted", "refutation must stick across a re-run (spec 12 R1 pattern)");
    assert.equal(third.skippedRefuted >= 1, true, "the refuted slot must be skipped, not re-asserted");
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});
