// tests/ui-server/native-routes.test.ts — docs/specs/27-native-side.md §L5:
// `GET /api/native/{modules,module/:x,seams,manifest,impl/:fn}`.
//
// Same fixture pair as `tests/gate/native/seams.test.ts` /
// `tests/gate/native/query-verbs.test.ts` (66-native-module-seams JS half +
// tests/fixtures/native/seams.apk native half), joined into a DB-backed
// project directory (`McpContext`, the ui-server's own resident backend) so
// this exercises the SAME `ArtifactService.dbBacked` path the real UI server
// runs -- native/ tables are flat JSONL regardless of backend (spec 27
// §L1), so `ingestNative` is called on the same directory after the DB is
// built, exactly like a real "ingest APK into an existing project" flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { splitProject } from "../../src/split/index.ts";
import { ingestNative, openApk } from "../../src/native/ingest.ts";
import { McpContext } from "../../src/mcp/context.ts";
import { handle, type UiServerCtx } from "../../src/ui-server/routes.ts";
import { repoRoot } from "../support/paths.ts";

const APK = join(repoRoot(), "tests", "fixtures", "native", "seams.apk");
const HBC = join(repoRoot(), "tests", "fixtures", "constructs", "66-native-module-seams", "v96.hbc");
const bytes = readFileSync(HBC);

function buildFixture(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-ui-native-"));
  const splitResult = splitProject(bytes, {});
  writeSplitResult(splitResult, outDir);
  // A flat `manifest.json` too, so the plain (non-DB) staleness test below
  // has one to corrupt -- `writeArtifact` writes both the flat index AND the
  // manifest; `initProjectDb` only adds `project.hbcproj` on top.
  writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
  const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
  const db = openProjectDb(join(outDir, "project.hbcproj"));
  try {
    initProjectDb(db, rows, { actorWho: "test" });
  } finally {
    db.close();
  }
  ingestNative(openApk(APK), outDir);
  return outDir;
}

const outDir = buildFixture();
test.after(() => rmSync(outDir, { recursive: true, force: true }));

const mcp = new McpContext(outDir, { hbc: HBC });
const ctx: UiServerCtx = { resources: mcp.resources, tools: mcp.tools, artifactDir: outDir };

async function get(path: string, query: Readonly<Record<string, string>> = {}): Promise<{ readonly status: number; readonly json: unknown }> {
  return await handle({ method: "GET", path, query, body: null }, ctx);
}

test("GET /api/native/modules lists react-modules.jsonl rows", async () => {
  const r = await get("/api/native/modules");
  assert.equal(r.status, 200);
  const j = r.json as { rows: { key: string; jsName: string | null }[]; total: number };
  assert.ok(j.total > 0);
  assert.ok(j.rows.some((m) => m.jsName === "Crypto"));
});

test("GET /api/native/module/:x returns the module, its methods, and its seams", async () => {
  const r = await get("/api/native/module/Crypto");
  assert.equal(r.status, 200);
  const j = r.json as { module: { jsName: string; methods: { jsName: string }[] }; seams: { key: string; status: string }[] };
  assert.equal(j.module.jsName, "Crypto");
  assert.ok(j.module.methods.some((m) => m.jsName === "generateKey"));
  assert.ok(j.seams.some((s) => s.key === "seam:Crypto.generateKey" && s.status === "linked"));
});

test("GET /api/native/module/:x on an unknown name is 404", async () => {
  const r = await get("/api/native/module/NoSuchModule");
  assert.equal(r.status, 404);
});

test("GET /api/native/seams?status=js-only returns only unlinked JS refs", async () => {
  const r = await get("/api/native/seams", { status: "js-only" });
  assert.equal(r.status, 200);
  const j = r.json as { rows: { status: string; native: unknown }[] };
  assert.ok(j.rows.length > 0);
  for (const row of j.rows) {
    assert.equal(row.status, "js-only");
    assert.equal(row.native, null);
  }
});

test("GET /api/native/seams?status=bogus is a 400, not a silent empty list", async () => {
  const r = await get("/api/native/seams", { status: "bogus" });
  assert.equal(r.status, 400);
});

test("GET /api/native/manifest returns the AXML-derived package block", async () => {
  const r = await get("/api/native/manifest");
  assert.equal(r.status, 200);
  const j = r.json as { permissions: string[] };
  assert.ok(Array.isArray(j.permissions));
});

test("GET /api/native/impl/:fn shows the native-impl row for a seam fn and nothing for a non-seam fn", async () => {
  const seamsR = await get("/api/native/seams", { status: "linked" });
  const seams = (seamsR.json as { rows: { key: string; jsEvidence: { callSites: string[] } | null }[] }).rows;
  const crypto = seams.find((s) => s.key === "seam:Crypto.generateKey");
  assert.ok(crypto !== undefined);
  const fn = Number(crypto!.jsEvidence!.callSites[0]!.slice("fn:".length));

  const withImpl = await get(`/api/native/impl/${fn}`);
  assert.equal(withImpl.status, 200);
  const withRows = (withImpl.json as { rows: { seam: { key: string }; module: { jsName: string } | null }[] }).rows;
  assert.ok(withRows.some((r) => r.seam.key === "seam:Crypto.generateKey" && r.module?.jsName === "Crypto"));

  const seamFns = new Set<number>();
  for (const s of seams) for (const c of s.jsEvidence?.callSites ?? []) seamFns.add(Number(c.slice("fn:".length)));
  let nonSeamFn = -1;
  for (let f = 0; f < 200; f++) {
    if (ctx.resources.artifact.hasFn(f) && !seamFns.has(f)) {
      nonSeamFn = f;
      break;
    }
  }
  assert.ok(nonSeamFn >= 0, "the fixture must have a fn outside every seam");
  const withoutImpl = await get(`/api/native/impl/${nonSeamFn}`);
  assert.equal(withoutImpl.status, 200);
  assert.deepEqual((withoutImpl.json as { rows: unknown[] }).rows, []);
});

test("GET /api/native/impl/:fn on an unknown fn is 404", async () => {
  const r = await get("/api/native/impl/999999");
  assert.equal(r.status, 404);
});

test("the route refuses a stale artifact with E_STALE_INDEX, same as every other /api/fn route", async () => {
  const staleDir = mkdtempSync(join(tmpdir(), "hbc2js-ui-native-stale-"));
  try {
    const splitResult = splitProject(bytes, {});
    writeArtifact({ bytes, splitResult, outDir: staleDir, passes: {}, strictEnv: false, form: "flat" });
    ingestNative(openApk(APK), staleDir);
    const manifestPath = join(staleDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { index: { builtFor: { bundleSha256: string } } };
    manifest.index.builtFor.bundleSha256 = "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    assert.throws(() => new McpContext(staleDir, { hbc: HBC }), /E_STALE_INDEX/);
  } finally {
    rmSync(staleDir, { recursive: true, force: true });
  }
});
