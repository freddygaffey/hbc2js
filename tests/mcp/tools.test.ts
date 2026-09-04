// tests/mcp/tools.test.ts — docs/specs/17-mcp-harness.md §2 (as revised
// §14): `src/mcp/tools.ts`'s `McpTools`, the transport-agnostic
// business-logic core of the WRITE tools. Builds a `.hbcproj` exactly the
// way `tests/mcp/resources.test.ts` does (same fixture-building recipe,
// reused per this round's brief) then asserts EFFECT (one annotation row +
// one `log` row per write, via `ProjectService.log`/`history`, this round's
// prerequisite) and the TRUTH RULES (evidence-must-resolve, no self-confirm,
// §14's dynamic-OR-fidelity-checked-static confirm gate) — never a literal-
// string compare against a shared fixture's decompiled output (CLAUDE.md /
// docs/CONSOLIDATION.md §B testing rules; this rung's own fixture is a
// private `.hbcproj` this file builds itself, not a construct fixture's
// rendered text).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { McpTools } from "../../src/mcp/tools.ts";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);
// A `fuzz:` ref resolving against the default DynamicResolver (existsSync
// relative to repo root, `src/project/evidence-resolver.ts`'s own rule) —
// the standing on-disk artifact this rung reuses as a real dynamic-role ref.
const DYNAMIC_REF = "fuzz:tests/fixtures/bundles/rn-template-0.72/index.android.hbc";

// Same pair `tests/mcp/resources.test.ts` discovered for this bundle: both
// own a real source range, so `fn:${FN}` resolves as a static evidence ref.
const FN = 188;

function buildFixture(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-mcp-tools-"));
  const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
  writeSplitResult(splitResult, outDir);
  const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
  const db = openProjectDb(join(outDir, "project.hbcproj"));
  try {
    initProjectDb(db, rows, { actorWho: "test" });
  } finally {
    db.close();
  }
  return outDir;
}

const outDir = buildFixture();
test.after(() => rmSync(outDir, { recursive: true, force: true }));

const tools = new McpTools(outDir, { hbc: RN_TEMPLATE });

const human = { source: "human" as const, who: "analyst@duck.com" };
const toolProv = { source: "tool" as const, who: "scanner", run: "run-1" };

function logTotal(): number {
  return tools.project.log({}, { all: true }).total;
}

function historyTotal(target: string): number {
  return tools.project.history(target, { all: true }).total;
}

test("set_name: lands one annotation + one log row", () => {
  const target = `fn:${FN}`;
  const logBefore = logTotal();
  const histBefore = historyTotal(target);
  const r = tools.setName({ target, name: "verifySignature", prov: human });
  assert.equal(logTotal(), logBefore + 1);
  assert.equal(historyTotal(target), histBefore + 1);
  assert.ok(r.line.includes(target));
  assert.ok(r.line.includes("verifySignature"));
});

test("add_comment: lands one annotation + one log row", () => {
  const target = `fn:${FN}`;
  const logBefore = logTotal();
  const histBefore = historyTotal(target);
  const r = tools.addComment({ target, body: "looks like a signature check", prov: human });
  assert.equal(logTotal(), logBefore + 1);
  assert.equal(historyTotal(target), histBefore + 1);
  assert.ok(r.line.length > 0);
});

test("add_tag: lands one annotation + one log row", () => {
  const target = `fn:${FN}`;
  const logBefore = logTotal();
  const histBefore = historyTotal(target);
  const r = tools.addTag({ target, tag: "suspicious", prov: human });
  assert.equal(logTotal(), logBefore + 1);
  assert.equal(historyTotal(target), histBefore + 1);
  assert.ok(r.line.includes("suspicious"));
});

test("record_finding: lands one annotation + one log row, minted open", () => {
  const target = `fn:${FN}`;
  const logBefore = logTotal();
  const histBefore = historyTotal(target);
  const r = tools.recordFinding({
    class: "high",
    location: { fn: FN },
    claim: "hardcoded key used to sign requests",
    evidence: [{ ref: target, role: "primary" }],
    prov: human,
  });
  assert.equal(logTotal(), logBefore + 1);
  assert.equal(historyTotal(target), histBefore + 1);
  assert.ok(r.line.includes("open"));
  assert.ok(typeof r.rid === "string" && r.rid.length > 0);
});

test("TRUTH RULE 1: record_finding rejects a finding with zero evidence refs", () => {
  assert.throws(
    () =>
      tools.recordFinding({
        class: "low",
        location: { fn: FN },
        claim: "no evidence at all",
        evidence: [],
        prov: human,
      }),
    /evidence/i,
  );
});

test("TRUTH RULE 1: record_finding rejects a finding whose only evidence ref does not resolve", () => {
  assert.throws(
    () =>
      tools.recordFinding({
        class: "low",
        location: { fn: FN },
        claim: "evidence points nowhere real",
        evidence: [{ ref: "fn:99999999", role: "primary" }],
        prov: human,
      }),
    /evidence/i,
  );
});

test("TRUTH RULE 2: a tool cannot self-confirm — open->confirmed refused for prov.source==='tool' even with resolving dynamic evidence", () => {
  const created = tools.recordFinding({
    class: "high",
    location: { fn: FN },
    claim: "self-confirm probe",
    evidence: [{ ref: `fn:${FN}`, role: "primary" }],
    prov: toolProv,
  });
  assert.throws(
    () =>
      tools.setFindingStatus({
        findingRid: created.rid,
        to: "confirmed",
        evidence: [{ ref: DYNAMIC_REF, role: "dynamic" }],
        prov: toolProv,
      }),
    /self-confirm/i,
  );
});

test("TRUTH RULE 3 (§14): set_finding_status accepts a resolving DYNAMIC repro ref for open->confirmed", () => {
  const created = tools.recordFinding({
    class: "high",
    location: { fn: FN },
    claim: "dynamic-confirm probe",
    evidence: [{ ref: `fn:${FN}`, role: "primary" }],
    prov: human,
  });
  const logBefore = logTotal();
  const r = tools.setFindingStatus({
    findingRid: created.rid,
    to: "confirmed",
    evidence: [{ ref: DYNAMIC_REF, role: "dynamic" }],
    prov: human,
  });
  assert.equal(logTotal(), logBefore + 1);
  assert.ok(r.line.includes("confirmed"));
});

test("TRUTH RULE 3 (§14): set_finding_status accepts a resolving fidelity-checked STATIC proof for open->confirmed", () => {
  const created = tools.recordFinding({
    class: "high",
    location: { fn: FN },
    claim: "static-confirm probe (hardcoded key, provable from the code alone)",
    evidence: [{ ref: `fn:${FN}`, role: "primary" }],
    prov: human,
  });
  const r = tools.setFindingStatus({
    findingRid: created.rid,
    to: "confirmed",
    evidence: [{ ref: `fn:${FN}`, role: "fidelity-checked" }],
    prov: human,
  });
  assert.ok(r.line.includes("confirmed"));
});

test("TRUTH RULE 3 (§14): set_finding_status rejects open->confirmed with only unevidenced/plain-static evidence (not dynamic, not fidelity-checked)", () => {
  const created = tools.recordFinding({
    class: "high",
    location: { fn: FN },
    claim: "unconfirmable probe",
    evidence: [{ ref: `fn:${FN}`, role: "primary" }],
    prov: human,
  });
  assert.throws(
    () =>
      tools.setFindingStatus({
        findingRid: created.rid,
        to: "confirmed",
        evidence: [{ ref: `fn:${FN}`, role: "context" }],
        prov: human,
      }),
    /dynamic|fidelity-checked/i,
  );
  assert.throws(
    () =>
      tools.setFindingStatus({
        findingRid: created.rid,
        to: "confirmed",
        evidence: [],
        prov: human,
      }),
    /evidence/i,
  );
});
