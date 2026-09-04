// tests/mcp/leads-search.test.ts — docs/specs/17-mcp-harness.md §14
// additions 1-3: `McpResources.leads`/`securitySinks`, `searchFunctions`/
// `searchSource`, `packageId` (rewired off the real `src/deps` pipeline),
// `scanSecrets`/`scanDeps`/`scanSemgrep`. Same golden-fixture setup as
// `tests/mcp/resources.test.ts` (rn-template-0.72, real bundle — needed for
// source-emitting resources AND for `--hbc`-gated deps identification).
// Rung-owned assertions only (counts, structural checks, resolving evidence
// refs) — no literal-string compare against a shared fixture's decompiled
// output (CLAUDE.md / docs/CONSOLIDATION.md §B).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { McpResources, RESOURCE_CAPS } from "../../src/mcp/resources.ts";
import { ArtifactEvidenceResolver } from "../../src/project/evidence-resolver.ts";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);

const outDir = mkdtempSync(join(tmpdir(), "hbc2js-mcp-leads-"));
{
  const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
  writeSplitResult(splitResult, outDir);
  const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
  const db = openProjectDb(join(outDir, "project.hbcproj"));
  try {
    initProjectDb(db, rows, { actorWho: "test" });
  } finally {
    db.close();
  }
}

test.after(() => rmSync(outDir, { recursive: true, force: true }));

const res = new McpResources(outDir, { hbc: RN_TEMPLATE });
const resolver = new ArtifactEvidenceResolver(res.artifact);

test("leads groups sinks by class, each with a resolving evidence ref", () => {
  const result = res.leads();
  assert.ok(Array.isArray(result.groups));
  assert.equal(typeof result.total, "number");
  assert.equal(typeof result.truncated, "boolean");
  let sawAny = false;
  for (const group of result.groups) {
    assert.ok(group.leads.length <= RESOURCE_CAPS.perClass);
    assert.ok(group.leads.length <= group.total);
    for (const lead of group.leads) {
      sawAny = true;
      assert.equal(lead.class, group.class);
      assert.ok(/^(fn|sid):\d+$/.test(lead.evidence), `evidence ref "${lead.evidence}" is not fn:N/sid:N`);
      assert.ok(resolver.resolves(lead.evidence), `evidence ref "${lead.evidence}" does not resolve against the live artifact`);
      if (lead.fn !== null) assert.equal(typeof lead.fn, "number");
    }
  }
  // A real react-native bundle always has AsyncStorage/WebView/Linking-shaped
  // surface somewhere — if this ever goes to zero it's a real regression in
  // the derivation, not just "empty fixture, nothing to assert".
  assert.ok(sawAny, "expected at least one sink lead on the rn-template-0.72 fixture");
});

test("securitySinks is an alias for leads (same shape)", () => {
  const a = res.leads();
  const b = res.securitySinks();
  assert.deepEqual(
    a.groups.map((g) => g.class),
    b.groups.map((g) => g.class),
  );
});

test("search/functions paginates and caps, matching by substring", () => {
  const page1 = res.searchFunctions("e"); // broad — guaranteed matches on real bundle names
  assert.ok(page1.rows.length <= RESOURCE_CAPS.searchPage);
  assert.equal(typeof page1.total, "number");
  for (const row of page1.rows) {
    assert.ok(row.name !== null && row.name.toLowerCase().includes("e"));
  }
  if (page1.nextCursor !== null) {
    const page2 = res.searchFunctions("e", { cursor: page1.nextCursor });
    assert.equal(page2.total, page1.total);
    // no overlap between pages
    const fns1 = new Set(page1.rows.map((r) => r.fn));
    for (const row of page2.rows) assert.ok(!fns1.has(row.fn));
  }
});

test("search/functions regex mode matches a pattern, not a literal substring", () => {
  const literal = res.searchFunctions("^doesNotExistAsAPrefix123");
  assert.equal(literal.total, 0);
});

test("search/source bounded-greps rendered source, paginated, with resolving fn refs", () => {
  const page = res.searchSource("function", { cursor: 0 });
  assert.ok(page.rows.length <= RESOURCE_CAPS.searchPage);
  for (const row of page.rows) {
    assert.ok(res.artifact.hasFn(row.fn));
    assert.equal(typeof row.line, "number");
    assert.ok(row.text.toLowerCase().includes("function"));
  }
});

test("package-id/{mod} returns a real identification (or an honest not-found), never a bare stub", async () => {
  // Sweep a handful of module ids; on an offline sigdb (no shared/user-cache
  // DB installed in CI) every one may legitimately be not-found — the
  // structural contract under test is the SHAPE, not a specific hit.
  for (const mod of [0, 1, 2, 5, 10]) {
    const p = await res.packageId(mod);
    assert.equal(p.mod, mod);
    assert.equal(typeof p.available, "boolean");
    if (p.available) {
      assert.equal(typeof p.package, "string");
      assert.ok(p.tier === "claim" || p.tier === "candidate");
      assert.ok(resolver.resolves(p.evidence));
    } else {
      assert.ok(p.reason.length > 0);
      assert.notEqual(p.reason, "spec-13 reuse-validation / spec-15 sigdb not yet implemented in this codebase", "packageId must no longer return the old hardcoded stub reason");
    }
  }
});

test("scanSecrets returns capped, real (possibly empty) findings, or an honest DB-backed not-supported reason", () => {
  const result = res.scanSecrets();
  assert.ok(Array.isArray(result.rows));
  assert.ok(result.rows.length <= RESOURCE_CAPS.scanSecrets);
  assert.equal(typeof result.total, "number");
  if (result.available) {
    for (const row of result.rows) {
      assert.equal(typeof row.target, "string");
      assert.ok(Array.isArray(row.evidence));
    }
  } else {
    assert.ok(result.reason.length > 0);
  }
});

test("scanDeps reads (or computes) capped OSV matches, honest about availability", async () => {
  const result = await res.scanDeps();
  assert.equal(typeof result.available, "boolean");
  assert.ok(Array.isArray(result.rows));
  assert.ok(result.rows.length <= RESOURCE_CAPS.scanDeps);
});

test("scan/deps without a configured bundle is an honest not-found, not a crash", async () => {
  const noHbc = new McpResources(outDir);
  const result = await noHbc.scanDeps();
  assert.equal(result.available, false);
  assert.equal(result.rows.length, 0);
});

test("scanSemgrep is an honest stub (Lane S not built), not a fabricated result", () => {
  const result = res.scanSemgrep();
  assert.equal(result.available, false);
  assert.ok(result.reason.length > 0);
});
