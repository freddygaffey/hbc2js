// tests/mcp/context.test.ts — docs/specs/17-mcp-harness.md §15 (spec 22
// §3.5's read-after-write note): `src/mcp/context.ts`'s `McpContext` shares
// ONE `ArtifactService`/`ProjectService` pair between `.resources`/`.tools`,
// so a write through `.tools` is visible to `.resources`'s very next read
// with no rebuild step — the property `src/ui-server/server.ts` used to
// need a manual rebuild for (docs/specs/22-ui-mvp.md §3.5's own note).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { McpContext } from "../../src/mcp/context.ts";
import { McpResources } from "../../src/mcp/resources.ts";
import { McpTools } from "../../src/mcp/tools.ts";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);
const FN = 188;

function buildFixture(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-mcp-context-"));
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

const human = { source: "human" as const, who: "analyst@duck.com" };

test("McpContext.resources/.tools share one ArtifactService/ProjectService instance", () => {
  const ctx = new McpContext(outDir, { hbc: RN_TEMPLATE });
  assert.equal(ctx.resources.artifact, ctx.artifact);
  assert.equal(ctx.resources.project, ctx.project);
  assert.equal(ctx.tools.artifact, ctx.artifact);
  assert.equal(ctx.tools.project, ctx.project);
});

test("a write through .tools is visible to .resources' very next read, no rebuild", () => {
  const ctx = new McpContext(outDir, { hbc: RN_TEMPLATE });
  const target = `fn:${FN}`;
  ctx.tools.setName({ target, name: "sharedContextName", prov: human });
  assert.equal(ctx.resources.fn(FN).acceptedName, "sharedContextName");
});

test("existing 2-arg McpResources/McpTools constructors are unaffected (own separate instances)", () => {
  const resources = new McpResources(outDir, { hbc: RN_TEMPLATE });
  const tools = new McpTools(outDir, { hbc: RN_TEMPLATE });
  assert.notEqual(resources.project, tools.project);
  assert.notEqual(resources.artifact, tools.artifact);
});
