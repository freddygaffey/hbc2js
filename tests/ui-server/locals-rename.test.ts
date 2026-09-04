// tests/ui-server/locals-rename.test.ts — identifier-level rename
// (`reg:F:R`) end to end: the `/api/fn/{fn}/locals` listing the UI joins a
// clicked token against, and the source read that must then SHOW the accepted
// name. Same rn-template-0.72 DB-backed fixture recipe as `routes.test.ts`
// (that file's own fixture note). Asserts structural properties only — never a
// literal-string compare against a shared fixture's decompiled output
// (CLAUDE.md / docs/CONSOLIDATION.md §B testing rules).
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
const FN = 188;

function buildFixture(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-locals-"));
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

test("GET /api/fn/{fn}/locals lists nameable registers with their rendered ident", async () => {
  const res = await get(`/api/fn/${FN}/locals`);
  assert.equal(res.status, 200);
  const body = res.json as { rows: readonly { reg: number; rendered: string; named: string | null; role: string; uses: number }[]; total: number };
  assert.ok(body.rows.length > 0, "fn 188 has nameable registers");
  assert.equal(body.total, body.rows.length);
  for (const row of body.rows) {
    assert.equal(typeof row.reg, "number");
    assert.equal(typeof row.role, "string");
    assert.ok(row.uses > 0);
    assert.equal(row.named, null);
    // passes-off render: every ident is still `rN`, keyed on its own register
    assert.equal(row.rendered, `r${row.reg}`);
  }
  // identical to the direct class call the route delegates to (no re-derivation)
  assert.deepEqual(body, mcp.resources.locals(FN));
});

test("GET /api/fn/{fn}/locals rejects a non-numeric fn", async () => {
  assert.equal((await get("/api/fn/nope/locals")).status, 400);
});

test("set_name reg:F:R is shown by the served source, and is a pure alpha-rename", async () => {
  const before = (await get(`/api/fn/${FN}/source`)).json as { text: string };
  const reg = (mcp.resources.locals(FN).rows.find((r) => r.uses > 1) ?? mcp.resources.locals(FN).rows[0]!).reg;
  const ident = new RegExp(`\\br${reg}\\b`);

  assert.ok(ident.test(before.text), `fn ${FN} source mentions r${reg} before the rename`);
  mcp.tools.setName({ target: `reg:${FN}:${reg}`, name: "firstPick", prov: human });

  const after = (await get(`/api/fn/${FN}/source`)).json as { text: string };
  assert.ok(/\bfirstPick\b/.test(after.text), "the accepted name is in the served source");
  // Frame-local by construction: this frame's own `r{reg}` idents are gone
  // (strictly fewer than before); a NESTED function's own `r{reg}` is a
  // different binding and is deliberately left alone.
  const count = (text: string): number => text.match(new RegExp(`\\br${reg}\\b`, "g"))?.length ?? 0;
  assert.ok(count(after.text) < count(before.text), `fewer bare r${reg} idents after the rename`);

  // `locals` reports the accepted name and the ident it now renders as
  const row = mcp.resources.locals(FN).rows.find((r) => r.reg === reg)!;
  assert.equal(row.named, "firstPick");
  assert.equal(row.rendered, "firstPick");

  // A second rename must differ from the first ONLY in that identifier —
  // renaming is an alpha-rename, never a change to emitted behaviour.
  mcp.tools.setName({ target: `reg:${FN}:${reg}`, name: "secondPick", prov: human });
  const renamed = (await get(`/api/fn/${FN}/source`)).json as { text: string };
  assert.ok(/\bsecondPick\b/.test(renamed.text));
  assert.equal(renamed.text.replace(/\bsecondPick\b/g, "firstPick"), after.text);

  // other functions are untouched by this function's overlay
  const other = (await get(`/api/fn/190/source`)).json as { text: string };
  assert.equal(/\b(firstPick|secondPick)\b/.test(other.text), false);
});
