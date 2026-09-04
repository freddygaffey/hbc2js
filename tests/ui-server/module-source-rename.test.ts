// tests/ui-server/module-source-rename.test.ts — GET /api/module/{id}/source
// honours accepted `reg:F:R` names (docs/UI.md used to say this whole-module
// FILE view was NOT overlay-aware, unlike `/api/fn/{fn}/source`). Same
// rn-template-0.72 DB-backed fixture recipe as `locals-rename.test.ts`.
// Asserts structural properties only — never a literal-string compare
// against a shared fixture's decompiled output (CLAUDE.md /
// docs/CONSOLIDATION.md §B testing rules).
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
import { handle, type UiServerCtx } from "../../src/ui-server/routes.ts";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);
// Module 5 owns fn 194/195/196 as three disjoint, contiguous SIBLING ranges
// (none nested in another) — probed once against this fixture; 195 is the
// rename target, 194/196 are its immediate before/after neighbours.
const MODULE = 5;
const FN_BEFORE = 194;
const FN_TARGET = 195;
const FN_AFTER = 196;

function buildFixture(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-modsrc-"));
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

const mcp = new McpContext(outDir, { hbc: RN_TEMPLATE });
const ctx: UiServerCtx = { resources: mcp.resources, tools: mcp.tools, artifactDir: outDir };
const human = { source: "human" as const, who: "analyst@duck.com" };

async function get(path: string): Promise<{ status: number; json: unknown }> {
  return await handle({ method: "GET", path, query: {}, body: null }, ctx);
}
async function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return await handle({ method: "POST", path, query: {}, body }, ctx);
}

interface ModuleSourceBody {
  readonly module: number;
  readonly file: string;
  readonly text: string;
  readonly functions: readonly { readonly fn: number; readonly name: string | null; readonly lines: readonly [number, number] }[];
  readonly renderedFns: readonly number[];
}

test("no active names: module source is byte-identical to disk, ranges match the artifact's", async () => {
  const res = await get(`/api/module/${MODULE}/source`);
  assert.equal(res.status, 200);
  const body = res.json as ModuleSourceBody;
  assert.deepEqual(body.renderedFns, []);
  const diskFile = mcp.resources.artifact.modulePath(mcp.resources.artifact.module(MODULE).file!);
  assert.equal(body.text, readFileSync(diskFile, "utf8"));
  const owned = mcp.resources.artifact
    .ownedFns(MODULE)
    .filter((f) => f.lines !== null)
    .sort((a, b) => a.lines![0] - b.lines![0]);
  assert.deepEqual(
    body.functions.map((f) => f.lines),
    owned.map((f) => f.lines),
  );
});

test("reg:F:R rename inside a module: renamed fn's range shows the name, the fn after re-anchors, the fn before is untouched", async () => {
  const before = (await get(`/api/module/${MODULE}/source`)).json as ModuleSourceBody;
  const beforeLines = before.text.split("\n");
  const fnBeforeRangeBefore = before.functions.find((f) => f.fn === FN_BEFORE)!;
  const fnBeforeTextBefore = beforeLines.slice(fnBeforeRangeBefore.lines[0] - 1, fnBeforeRangeBefore.lines[1]).join("\n");

  const reg = mcp.resources.locals(FN_TARGET).rows[0]!.reg;
  const setRes = await post("/api/tools/set-name", { target: `reg:${FN_TARGET}:${reg}`, name: "renamedLocal", prov: human });
  assert.equal(setRes.status, 200);

  const after = (await get(`/api/module/${MODULE}/source`)).json as ModuleSourceBody;
  assert.deepEqual(after.renderedFns, [FN_TARGET]);

  // the new name is inside the renamed fn's own (remapped) range
  const afterLines = after.text.split("\n");
  const targetRange = after.functions.find((f) => f.fn === FN_TARGET)!;
  const targetText = afterLines.slice(targetRange.lines[0] - 1, targetRange.lines[1]).join("\n");
  assert.ok(/\brenamedLocal\b/.test(targetText), "renamed identifier is inside the target fn's own range");

  // the fn AFTER it still has a range whose first line starts that function
  // — compared against the fn's own `/api/fn/{fn}/source` first line
  const afterFnRange = after.functions.find((f) => f.fn === FN_AFTER)!;
  const afterFnFirstLine = afterLines[afterFnRange.lines[0] - 1];
  const afterFnOwnSource = (await get(`/api/fn/${FN_AFTER}/source`)).json as { text: string };
  assert.equal(afterFnFirstLine, afterFnOwnSource.text.split("\n")[0]);

  // the fn BEFORE it is unchanged (same text, its own range untouched)
  const fnBeforeRangeAfter = after.functions.find((f) => f.fn === FN_BEFORE)!;
  assert.deepEqual(fnBeforeRangeAfter.lines, fnBeforeRangeBefore.lines);
  const fnBeforeTextAfter = afterLines.slice(fnBeforeRangeAfter.lines[0] - 1, fnBeforeRangeAfter.lines[1]).join("\n");
  assert.equal(fnBeforeTextAfter, fnBeforeTextBefore);
});
