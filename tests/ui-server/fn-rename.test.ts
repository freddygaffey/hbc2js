// tests/ui-server/fn-rename.test.ts — an ACCEPTED `fn:N` name must reach the
// screen, not just the database (Fred, 2026-09-05: "Rename doesn't work in the
// UI" — POST /api/tools/set-name returned 200, `acceptedName` came back on
// /api/fn/{fn}, and every rendered surface still showed the old name).
// Same rn-template-0.72 DB-backed fixture recipe as
// `module-source-rename.test.ts`, and the same rule: structural, rung-owned
// assertions only, never a literal-string compare against a shared fixture's
// decompiled output (CLAUDE.md / docs/CONSOLIDATION.md §B).
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
const NEW_NAME = "renamedFunctionAlpha";

function buildFixture(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-fnrename-"));
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

async function get(path: string, query: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
  return await handle({ method: "GET", path, query, body: null }, ctx);
}
async function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return await handle({ method: "POST", path, query: {}, body }, ctx);
}

/** The first function in the fixture that is renderable (own line range) and
 *  is REFERENCED BY IDENT (`_fnN`) in a renderable caller's own text — probed,
 *  not pinned, so the test encodes no fixture line number. Referenced by ident
 *  matters: a `require()`-resolved edge names no function, so it could never
 *  show a rename however the server rendered it. */
const SCAN_CAP = 400;
function pickTargetAndCaller(): { readonly target: number; readonly caller: number } {
  const artifact = mcp.resources.artifact;
  let scanned = 0;
  for (const { fn } of artifact.listFns()) {
    if (scanned++ >= SCAN_CAP) break;
    if (artifact.fn(fn).lines === null) continue;
    const ref = new RegExp(`\\b_fn${fn}\\b`);
    for (const e of artifact.whoCalls(fn, { all: true }).rows) {
      if (typeof e.fn !== "number" || e.fn === fn) continue;
      if (artifact.fn(e.fn).lines === null) continue;
      if (ref.test(artifact.source(e.fn))) return { target: fn, caller: e.fn };
    }
  }
  throw new Error("fixture has no function referenced by ident from a renderable caller");
}

const { target: TARGET, caller: CALLER } = pickTargetAndCaller();

interface SourceBody {
  readonly text: string;
}
interface FunctionsPage {
  readonly rows: readonly { readonly fn: number; readonly name: string | null }[];
  readonly nextCursor: number | null;
}

async function functionsRow(fn: number): Promise<{ readonly fn: number; readonly name: string | null } | undefined> {
  let cursor = 0;
  for (let page = 0; page < 200; page++) {
    const res = await get("/api/functions", { cursor: String(cursor), limit: "500" });
    const body = res.json as FunctionsPage;
    const hit = body.rows.find((r) => r.fn === fn);
    if (hit !== undefined) return hit;
    if (body.nextCursor === null) return undefined;
    cursor = body.nextCursor;
  }
  return undefined;
}

test("fn:N rename before the write: no surface shows the new name", async () => {
  const beforeRow = await functionsRow(TARGET);
  assert.notEqual(beforeRow, undefined);
  assert.notEqual(beforeRow!.name, NEW_NAME);
  const src = (await get(`/api/fn/${TARGET}/source`)).json as SourceBody;
  assert.ok(!new RegExp(`\\b${NEW_NAME}\\b`).test(src.text));
});

test("an accepted fn:N name is rendered: the declaration, the catalogue row, and the caller's reference", async () => {
  const callerBefore = (await get(`/api/fn/${CALLER}/source`)).json as SourceBody;

  const setRes = await post("/api/tools/set-name", { target: `fn:${TARGET}`, name: NEW_NAME, prov: human });
  assert.equal(setRes.status, 200);

  // (a) the function's own rendered source declares the new name — the bug:
  // `/api/fn/{fn}/context` kept serving the old `function <old>(...)` header.
  const ctxRes = (await get(`/api/fn/${TARGET}/context`)).json as {
    readonly source?: SourceBody;
    readonly metadata?: { readonly acceptedName?: string };
  };
  assert.equal(ctxRes.metadata?.acceptedName, NEW_NAME);
  assert.match(ctxRes.source!.text, new RegExp(`function\\s+${NEW_NAME}\\s*\\(`), "the rendered declaration carries the accepted name");

  // (b) the catalogue row the tree/search render from
  const row = await functionsRow(TARGET);
  assert.equal(row?.name, NEW_NAME);

  // (c) the caller references it by the new name (a `fn:N` rename is
  // module-scoped: the declaration AND every reference move together), and
  // the caller's own `_fn<CALLER>` ident is NOT touched.
  assert.match(callerBefore.text, new RegExp(`\\b_fn${TARGET}\\b`), "precondition: the caller referenced the target by its default ident");
  const callerAfter = (await get(`/api/fn/${CALLER}/source`)).json as SourceBody;
  assert.match(callerAfter.text, new RegExp(`\\b${NEW_NAME}\\b`), "the caller's rendered source references the new name");
  assert.ok(!new RegExp(`\\b_fn${TARGET}\\b`).test(callerAfter.text), "no stale reference to the old ident is left behind");
});

test("the caller's whole-module FILE view is re-spliced too (module-source cache invalidation)", async () => {
  const mod = mcp.resources.artifact.fn(CALLER).module;
  assert.notEqual(mod, null);
  const body = (await get(`/api/module/${mod}/source`)).json as {
    readonly text: string;
    readonly renderedFns: readonly number[];
    readonly functions: readonly { readonly fn: number; readonly name: string | null }[];
  };
  assert.ok(body.renderedFns.includes(CALLER), "the caller is re-rendered in the module view");
  assert.match(body.text, new RegExp(`\\b${NEW_NAME}\\b`));
  const owned = body.functions.find((f) => f.fn === TARGET);
  if (owned !== undefined) assert.equal(owned.name, NEW_NAME, "the module view's own function list uses the accepted name");
});

// Regression: docs/BUGS.md "search/functions matches the bytecode name
// only" (fn-rename landing) — `/api/search/functions` displayed the accepted
// name but only matched the pre-rename bytecode name, so typing the name a
// rename JUST gave a function found nothing.
interface SearchFunctionsPage {
  readonly rows: readonly { readonly fn: number; readonly name: string | null }[];
}

test("/api/search/functions matches the accepted (post-rename) name, not only the bytecode name", async () => {
  const res = await get("/api/search/functions", { q: NEW_NAME });
  assert.equal(res.status, 200);
  const page = res.json as SearchFunctionsPage;
  const hit = page.rows.find((r) => r.fn === TARGET);
  assert.notEqual(hit, undefined, "searching for the accepted name must find the renamed function");
  assert.equal(hit?.name, NEW_NAME);
});
