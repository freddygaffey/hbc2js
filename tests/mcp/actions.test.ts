// tests/mcp/actions.test.ts — docs/specs/17-mcp-harness.md §13/§14: the
// three ACTION tools `src/mcp/tools.ts` added this round —
// `requestFidelityCheck` (§14, wired to `request_fidelity_check`),
// `recompileEdit`/`recompileEditAndRun` (§13, `recompile_edit`), and
// `generateDocumentation` (§14, `generate_documentation`). Same golden
// `.hbcproj` fixture recipe as `tests/mcp/tools.test.ts` (a real bundle, not
// a construct fixture — this rung's own private fixture, never a literal-
// string compare against shared fixture output, CLAUDE.md's testing rule).
// Real `hermesc` recompiles are kept to ONE small standalone snippet per the
// brief's gate-fast instruction — the point under test is the tool's own
// plumbing (watermark/warning/no-mutate/log-row/evidence shape), not
// hermesc's own correctness (that is `tests/gate/harness/roundtrip*`'s job).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { McpTools } from "../../src/mcp/tools.ts";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);
const FN = 188;

function buildFixture(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-mcp-actions-"));
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

// A small standalone snippet that compiles under any RN-template hermesc
// version (v94 for this fixture) without depending on the real fn 188's own
// (module-scoped) semantics — the gate-fast recompile the brief asks for.
const SMALL_EDIT_SOURCE = "function patched(a, b) { return a + b; }\nprint(patched(1, 2));\n";

// ---------------------------------------------------------------------------
// request_fidelity_check
// ---------------------------------------------------------------------------

test("request_fidelity_check: PASS candidate returns a fidelity-checked evidence ref", async () => {
  const r = await tools.requestFidelityCheck({ fn: FN, candidateSource: SMALL_EDIT_SOURCE });
  assert.equal(r.verdict, "PASS");
  assert.ok(r.oracles.some((o) => o.oracle === "syntax" && o.verdict === "PASS"));
  assert.deepEqual(r.evidence, { ref: `fn:${FN}`, role: "fidelity-checked" });
});

test("request_fidelity_check: DIVERGENT candidate (syntax error) returns no confirming evidence", async () => {
  const r = await tools.requestFidelityCheck({ fn: FN, candidateSource: "function broken( {\n" });
  assert.equal(r.verdict, "DIVERGENT");
  assert.equal(r.evidence, null);
});

test("request_fidelity_check: writes nothing (no log row) — it only returns evidence", async () => {
  const before = tools.project.log({}, { all: true }).total;
  await tools.requestFidelityCheck({ fn: FN, candidateSource: SMALL_EDIT_SOURCE });
  const after = tools.project.log({}, { all: true }).total;
  assert.equal(after, before);
});

test("request_fidelity_check evidence can confirm a finding (§14 truth rule 3, end to end)", async () => {
  const created = tools.recordFinding({
    class: "high",
    location: { fn: FN },
    claim: "fidelity-check-confirmed probe",
    evidence: [{ ref: `fn:${FN}`, role: "primary" }],
    prov: human,
  });
  const check = await tools.requestFidelityCheck({ fn: FN, candidateSource: SMALL_EDIT_SOURCE });
  assert.ok(check.evidence !== null);
  const r = tools.setFindingStatus({
    findingRid: created.rid,
    to: "confirmed",
    evidence: [check.evidence!],
    prov: human,
  });
  assert.ok(r.line.includes("confirmed"));
});

// ---------------------------------------------------------------------------
// recompile_edit
// ---------------------------------------------------------------------------

test("recompile_edit: compiles the edit, watermarks it, logs one row, never touches the original bundle", () => {
  const bundleHashBefore = readFileSync(RN_TEMPLATE);
  const logBefore = tools.project.log({}, { all: true }).total;
  const histBefore = tools.project.history(`fn:${FN}`, { all: true }).total;

  const r = tools.recompileEdit({ fn: FN, source: SMALL_EDIT_SOURCE, prov: human });

  // REQUIRED warning present, unconditionally.
  assert.match(r.warning, /MODIFIED BINARY/);
  assert.match(r.warning, /not a read-only answer/);

  // Watermark: provenance record marks it edited-and-recompiled, base
  // bundle hash + the edit.
  assert.equal(r.watermark.kind, "edited-and-recompiled");
  assert.equal(r.watermark.fn, FN);
  assert.equal(r.watermark.baseBundleSha256.length, 64);
  assert.equal(r.watermark.editSha256.length, 64);

  // Output is a real recompiled artifact, distinct from and outside the
  // original bundle path and the project directory.
  assert.ok(readFileSync(r.outputPath).length > 0);
  assert.notEqual(resolve(r.outputPath), resolve(RN_TEMPLATE));
  assert.ok(!resolve(r.outputPath).startsWith(resolve(outDir)));

  // Original bundle bytes are byte-for-byte unchanged.
  assert.deepEqual(readFileSync(RN_TEMPLATE), bundleHashBefore);

  // It writes exactly one annotation + one log row, like any other action.
  assert.equal(tools.project.log({}, { all: true }).total, logBefore + 1);
  assert.equal(tools.project.history(`fn:${FN}`, { all: true }).total, histBefore + 1);
  assert.ok(typeof r.rid === "string" && r.rid.length > 0);
});

test("recompile_edit: rejects a source that fails to compile, writes nothing", () => {
  const logBefore = tools.project.log({}, { all: true }).total;
  assert.throws(() => tools.recompileEdit({ fn: FN, source: "function broken( {\n", prov: human }), /hermesc/i);
  assert.equal(tools.project.log({}, { all: true }).total, logBefore);
});

test("recompile_edit with runTrace: true carries the executed edit's print trace", async () => {
  const r = await tools.recompileEditAndRun({ fn: FN, source: SMALL_EDIT_SOURCE, prov: human, runTrace: true });
  assert.ok(r.trace !== undefined);
  assert.ok(r.trace!.print.some((line) => line.includes("3")));
});

// ---------------------------------------------------------------------------
// generate_documentation
// ---------------------------------------------------------------------------

test("generate_documentation: emits a self-contained repro report covering findings + log, deterministically", () => {
  const doc1 = tools.generateDocumentation();
  const doc2 = tools.generateDocumentation();
  assert.equal(doc1.report, doc2.report, "same project state must produce byte-identical reports");

  assert.match(doc1.report, /# hbc2js analysis session/);
  assert.match(doc1.report, new RegExp(`Base bundle sha256: [0-9a-f]{64}`));
  assert.match(doc1.report, /## Findings/);
  assert.match(doc1.report, /## Session log/);
  assert.match(doc1.report, /## recompile_edit actions/);
  assert.match(doc1.report, /fn 188/);
  assert.match(doc1.report, new RegExp(SMALL_EDIT_SOURCE.split("\n")[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(doc1.report, /fidelity-check-confirmed probe/);
});
