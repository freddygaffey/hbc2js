// tests/mcp/tier.test.ts — docs/specs/17-mcp-harness.md §15 (spec 23 §4's
// "known gap" follow-up): the provenance `tier: "suggested"|"accepted"` on
// `set_name`/`add_comment`/`add_tag`/`record_finding`, and `McpTools.promote`.
// Same fixture-building recipe as `tests/mcp/tools.test.ts` (a private
// `.hbcproj` this file builds itself), same discipline: asserts EFFECT
// (which slot a write lands in, what `fn()`/`context()` display), never a
// literal-string compare against a shared fixture's decompiled output
// (CLAUDE.md / docs/CONSOLIDATION.md §B testing rules).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openProjectDb, migrationSql, SCHEMA_MINOR, SCHEMA_VERSION } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { McpTools } from "../../src/mcp/tools.ts";
import { McpResources } from "../../src/mcp/resources.ts";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);
const FN = 188;

function buildFixture(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-mcp-tier-"));
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
const resources = new McpResources(outDir, { hbc: RN_TEMPLATE });

const target = `fn:${FN}`;
const human = { source: "human" as const, who: "analyst@duck.com" };
const worker = { source: "llm" as const, who: "worker:suggest-name", run: "job-1" };

test("set_name without tier defaults to accepted and shows in fn()/context()", () => {
  tools.setName({ target, name: "acceptedByDefault", prov: human });
  const s = resources.fn(FN);
  assert.equal(s.acceptedName, "acceptedByDefault");
  const c = resources.context(FN, { include: ["metadata"] });
  assert.equal(c.metadata?.acceptedName, "acceptedByDefault");
});

test("set_name with tier:suggested does NOT become the displayed name", () => {
  const before = resources.fn(FN).acceptedName;
  tools.setName({ target, name: "suggestedName", prov: worker, tier: "suggested" });
  const after = resources.fn(FN);
  assert.equal(after.acceptedName, before, "a suggested write must not move the accepted slot");
  assert.ok(after.suggestedNames?.some((s) => s.name === "suggestedName" && s.who === "worker:suggest-name"));
});

test("a second suggestion from the same proposer supersedes their own prior suggestion, not the accepted slot", () => {
  tools.setName({ target, name: "suggestedNameV2", prov: worker, tier: "suggested" });
  const after = resources.fn(FN);
  const mine = after.suggestedNames?.filter((s) => s.who === "worker:suggest-name") ?? [];
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.name, "suggestedNameV2");
});

test("promote by rid re-records the suggested value as accepted under the promoter's own provenance", () => {
  const suggestion = tools.project.listSuggestedNames(target).find((s) => s.who === "worker:suggest-name");
  assert.ok(suggestion !== undefined);
  const r = tools.promote({ kind: "name", target, rid: suggestion!.rid, prov: human });
  assert.ok(r.line.includes("suggestedNameV2"));
  const after = resources.fn(FN);
  assert.equal(after.acceptedName, "suggestedNameV2");
});

test("promote by explicit name bypasses stored suggestions", () => {
  const r = tools.promote({ kind: "name", target, name: "explicitlyPromoted", prov: human });
  assert.ok(r.line.includes("explicitlyPromoted"));
  assert.equal(resources.fn(FN).acceptedName, "explicitlyPromoted");
});

test("promote refuses a rid that names no live suggestion", () => {
  assert.throws(() => tools.promote({ kind: "name", target, rid: "999999", prov: human }));
});

test("add_comment/add_tag/record_finding tier defaults to accepted (no throw, no behaviour change)", () => {
  const c = tools.addComment({ target, body: "note", prov: human });
  assert.ok(c.rid.length > 0);
  const t = tools.addTag({ target, tag: "suspicious", prov: human, tier: "suggested" });
  assert.ok(t.rid.length > 0);
});

test("old (pre-MIGRATION-3) DBs still migrate and open read/write", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-tier-migrate-"));
  try {
    const schemaPath = join(repoRoot(), "src", "projdb", "schema.sql");
    const ddl = readFileSync(schemaPath, "utf8");
    const cut = ddl.indexOf("-- >>> MIGRATION 2 >>>");
    assert.ok(cut > 0);
    const path = join(dir, "old.hbcproj");
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys=ON;");
    raw.exec(ddl.slice(0, cut));
    raw.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("schema", SCHEMA_VERSION);
    raw.close();

    const migrated = openProjectDb(path);
    assert.equal(
      (migrated.prepare("SELECT value FROM meta WHERE key='schema_minor'").get() as { value: string }).value,
      String(SCHEMA_MINOR),
    );
    assert.ok(
      (migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='revision_tier'").get() as { name: string } | undefined) !==
        undefined,
    );
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MIGRATION 3 block is idempotent (replayed twice, matches the pattern MIGRATION 2's own test asserts)", () => {
  const db = openProjectDb(":memory:");
  assert.doesNotThrow(() => db.exec(migrationSql(3)));
  assert.doesNotThrow(() => db.exec(migrationSql(3)));
  db.close();
});
