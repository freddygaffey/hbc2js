// T4 (spec 12 §8) — artifact-boundary + store round-trip. Depends on the
// scan driver (step 2) and store integration (step 3), neither of which
// exists at impl step 0; guarded per the tag-supersession.test.ts pattern.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { materializeArtifact } from "./support/materialize.ts";

const SERVICE_PATH = "../../src/secrets/service.ts";

interface Finding {
  kind: "finding";
  target: string; // "sid:N"
  evidence: { ref: string; role: string; patternId?: string }[];
  prov: { source: string };
  ctx: { patternId?: string };
}

test("T4 scan over the seeded artifact: evidence resolves, one finding per (sid,patternId), data-only string still finds, idempotent re-scan", async () => {
  const mod = (await import(SERVICE_PATH).catch(() => null)) as null | {
    SecretsService: new (...args: unknown[]) => {
      scan: (opts?: { force?: boolean }) => { new: number; cached: number };
      list: (q?: { category?: string; tier?: string }) => Finding[];
    };
  };
  assert.ok(mod, `${SERVICE_PATH} does not exist yet (spec 12 §9 steps 2-3)`);
  if (!mod) return;

  // Materialize the true (real-format) artifact into a scratch dir — the
  // checked-in fixture is defused at rest, see
  // tests/fixtures/secrets/seeded/README.md.
  const fixtureDir = materializeArtifact() + "/";
  const strings = JSON.parse(readFileSync(join(fixtureDir, "index", "strings.json"), "utf8")) as {
    entries: { sid: number }[];
  };
  const usesLines = readFileSync(join(fixtureDir, "index", "string-uses.jsonl"), "utf8").trim().split("\n").slice(1);
  const validFns = new Set(usesLines.map((l) => JSON.parse(l).fn as number));
  const sids = new Set(strings.entries.map((e) => e.sid));

  const { SecretsService } = mod;
  const svc = new SecretsService({ artifactDir: fixtureDir });
  svc.scan({ force: true });
  const findings = svc.list();

  const slots = new Set<string>();
  for (const f of findings) {
    assert.equal(f.kind, "finding");
    assert.equal(f.prov.source, "tool");
    const sid = Number(f.target.replace(/^sid:/, ""));
    assert.ok(sids.has(sid), `evidence sid ${sid} must resolve against strings.json`);
    for (const ev of f.evidence) {
      if (ev.role === "match") assert.ok(ev.ref === f.target);
      if (ev.role === "use-site") {
        const fn = Number(ev.ref.replace(/^fn:/, ""));
        assert.ok(validFns.has(fn), `use-site fn:${fn} must come from string-uses.jsonl`);
      }
    }
    const slotKey = `${f.target}:${f.ctx.patternId}`;
    assert.ok(!slots.has(slotKey), `duplicate finding for slot ${slotKey} (spec 12 R3)`);
    slots.add(slotKey);
  }

  // The data-only seeded string (sid 1, "AKIAIOSFODNN7EXAMPLE") has zero use
  // rows on purpose and must still produce a finding.
  const dataOnly = findings.find((f) => f.target === "sid:1");
  assert.ok(dataOnly, "data-only seeded string must still produce a finding");

  const before = svc.scan({ force: false });
  assert.equal(before.new, 0, "idempotent re-scan: zero superseded/new records");
  assert.ok(before.cached > 0, "idempotent re-scan: cache hits > 0");
});
