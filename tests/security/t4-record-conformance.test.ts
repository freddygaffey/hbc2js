// tests/security/t4-record-conformance.test.ts — T4 (spec 13 §10, §7). Every
// lane-written record resolves all evidence via ArtifactService re-check;
// provenance fields present; every candidate-tier claim text starts
// "candidate:"; no tool record has status other than "open".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeps } from "../../src/deps/index.ts";
import { loadOsvSlice, matchOsv, OsvService, moduleEvidenceResolver } from "../../src/security/osv-adapter.ts";
import { repoRoot } from "../support/paths.ts";

const FIXTURE_DIR = join(repoRoot(), "tests", "fixtures", "security", "vuln-app");

test("T4: every Lane O record resolves evidence, carries provenance, and has status \"open\"", async () => {
  const { report } = await runDeps(join(FIXTURE_DIR, "v96.hbc"), { sigdb: join(FIXTURE_DIR, "sigdb"), noSharedDb: true, offline: true });
  const slice = loadOsvSlice();
  const matches = matchOsv(report, slice);
  assert.ok(matches.length > 0, "fixture must produce at least one Lane O match to exercise this test");

  const scratchDir = mkdtempSync(join(tmpdir(), "hbc2js-osv-t4-"));
  try {
    const svc = new OsvService({ projectDir: scratchDir });
    const summary = svc.writeMatches(matches, report, { dbDate: slice._retrieved, runId: "t4-run", reportHash: "deadbeef" });
    assert.ok(summary.new > 0, "expected at least one new finding written");

    const resolver = moduleEvidenceResolver(report);
    for (const f of svc.allFindings()) {
      assert.ok(f.evidence.length > 0, `finding ${f.rid} must carry >=1 evidence ref`);
      assert.ok(
        f.evidence.some((e) => resolver.resolves(e.ref)),
        `finding ${f.rid}'s evidence must resolve via ArtifactService re-check (got refs: ${f.evidence.map((e) => e.ref).join(",")})`,
      );
      assert.equal(f.prov.source, "tool");
      assert.ok(f.prov.who.startsWith("osv@"), `provenance who must be osv@<db-date>+... , got ${f.prov.who}`);
      assert.equal(svc.statusOf(f.rid), "open", "tools write status open only (spec 12 §4.3 precedent, spec 13 §7)");
      if (f.claim.startsWith("candidate:") === false) {
        assert.match(f.claim, /^vulnerable dependency:/, "every non-candidate claim must be the unprefixed claim-tier wording");
      }
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});
