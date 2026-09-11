// tests/ui-server/readability-routes.test.ts — spec 28 landing 4c's HTTP
// surface over `src/readability/surfaces.ts`. Rung-owned properties only
// (docs/CONSOLIDATION.md §B item 7): status codes, filter counts, and the
// shape of what a route hands back — never a literal-string assertion
// against the shared construct fixture's decompiled output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { makeTree } from "../support/readability-tree.ts";
import { handle, type UiServerCtx } from "../../src/ui-server/routes.ts";
import type { ReadabilityRoutesCtx } from "../../src/ui-server/readability-routes.ts";
import { FakeBackend } from "../../src/workers/backend.ts";
import type { ReadabilityContext } from "../../src/readability/surfaces.ts";
import type { TreeEquivOracle } from "../../src/readability/file-ops.ts";

const FIXTURE = "04-for-loop-basic";
const VERSION = 94; // same version `tests/support/readability-tree.ts`'s own fixtureSource() renders

function hbcPath(): string {
  return join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, `v${String(VERSION)}.hbc`);
}

const PASS_TREE: TreeEquivOracle = () => ({ verdict: "PASS", why: "stub PASS", oracle: "test stub", lines: 4 });

function baseCtx(backend = new FakeBackend()): { readonly ui: UiServerCtx; readonly readability: ReadabilityRoutesCtx } {
  const { db, projectDir, treeDir } = makeTree();
  const context: ReadabilityContext = { db, projectDir, treeDir, backend, hbcPath: hbcPath(), oracle: PASS_TREE };
  const readability: ReadabilityRoutesCtx = { context, backendId: backend.id };
  // A minimal `UiServerCtx` — these routes never touch `resources`/`tools`,
  // so `undefined` stand-ins keep this file from having to build a whole
  // `McpContext` just to exercise `/api/readability/*`.
  const ui = { resources: undefined, tools: undefined, artifactDir: projectDir, readability } as unknown as UiServerCtx;
  return { ui, readability };
}

function get(ctx: UiServerCtx, path: string, query: Record<string, string> = {}) {
  return handle({ method: "GET", path, query, body: undefined }, ctx);
}
function post(ctx: UiServerCtx, path: string, body: unknown) {
  return handle({ method: "POST", path, query: {}, body }, ctx);
}

test("GET /api/readability/suggestions: 503 with no readability ctx, empty list with one configured", async () => {
  const { ui } = baseCtx();
  const off = { resources: undefined, tools: undefined, artifactDir: "/x" } as unknown as UiServerCtx;
  const res503 = await get(off, "/api/readability/suggestions");
  assert.equal(res503.status, 503);

  const res = await get(ui, "/api/readability/suggestions");
  assert.equal(res.status, 200);
  const json = res.json as { suggestions: readonly unknown[]; total: number; backend: string };
  assert.deepEqual(json.suggestions, []);
  assert.equal(json.total, 0);
  assert.equal(json.backend, "fake");
});

test("suggest-names action seeds a name suggestion the list route then sees, filterable by confidence", async () => {
  const backend = new FakeBackend({
    replies: {
      "suggest-name": () =>
        JSON.stringify({ names: [{ bindingId: { fn: 0, reg: 9 }, name: "loopCount", confidence: "high", evidence: "loop bound" }], abstained: false }),
    },
  });
  const { ui } = baseCtx(backend);

  const action = await post(ui, "/api/readability/actions/suggest-names", { fn: 0 });
  assert.equal(action.status, 200);
  const actionJson = action.json as { suggestions: readonly { readonly name: string }[]; equiv: { readonly verdict: string } };
  assert.ok(actionJson.suggestions.length > 0);
  assert.equal(actionJson.equiv.verdict, "PASS");

  // suggest_names proposes one name per nameable register in the fn (name-pass.ts
  // writes to `target.bindingId`, not the echoed bindingId in the model's own
  // reply — the FakeBackend's reply is a constant, so the count is however many
  // nameable registers fn:0 has, not 1).
  const listed = await get(ui, "/api/readability/suggestions");
  const listedJson = listed.json as { suggestions: readonly { readonly kind: string; readonly confidence?: string }[]; total: number };
  assert.ok(listedJson.total > 0);
  assert.equal(listedJson.suggestions[0]?.kind, "name");

  const wrongConfidence = await get(ui, "/api/readability/suggestions", { confidence: "low" });
  assert.equal((wrongConfidence.json as { total: number }).total, 0);
  const rightConfidence = await get(ui, "/api/readability/suggestions", { confidence: "high" });
  assert.equal((rightConfidence.json as { total: number }).total, listedJson.total);
});

test("suggest-names action: missing target is a 400, not a 500", async () => {
  const { ui } = baseCtx();
  const res = await post(ui, "/api/readability/actions/suggest-names", {});
  assert.equal(res.status, 400);
});

test("promote/revert a name suggestion through the routes, refusing a worker: who", async () => {
  const backend = new FakeBackend({
    replies: {
      "suggest-name": () =>
        JSON.stringify({ names: [{ bindingId: { fn: 0, reg: 9 }, name: "loopCount", confidence: "high", evidence: "loop bound" }], abstained: false }),
    },
  });
  const { ui } = baseCtx(backend);
  await post(ui, "/api/readability/actions/suggest-names", { fn: 0 });
  const listed = (await get(ui, "/api/readability/suggestions")).json as { suggestions: readonly { readonly suggestionId: string }[] };
  const suggestionId = listed.suggestions[0]!.suggestionId;

  const refused = await post(ui, "/api/readability/promote", { suggestionId, who: "worker:haiku" });
  assert.equal(refused.status, 409);

  const promoted = await post(ui, "/api/readability/promote", { suggestionId, who: "reviewer@example.com" });
  assert.equal(promoted.status, 200);
  assert.equal((promoted.json as { tier: string }).tier, "confirmed");

  const reverted = await post(ui, "/api/readability/revert", { suggestionId });
  assert.equal(reverted.status, 200);
});

test("promote: neither txId nor suggestionId is a 400", async () => {
  const { ui } = baseCtx();
  const res = await post(ui, "/api/readability/promote", { who: "reviewer@example.com" });
  assert.equal(res.status, 400);
});

test("combine-files action: validates shape, runs the file op, and lists the resulting transaction", async () => {
  const { ui } = baseCtx();
  const badShape = await post(ui, "/api/readability/actions/combine-files", { inputs: ["src/module_1.js"], outputs: ["combined.js"], evidence: "x" });
  assert.equal(badShape.status, 400);

  const res = await post(ui, "/api/readability/actions/combine-files", {
    inputs: ["src/module_1.js", "src/module_2.js"],
    outputs: ["combined.js"],
    evidence: "both files are the same loop helper",
  });
  assert.equal(res.status, 200);
  const json = res.json as { accepted: boolean; txId?: string; equiv: { verdict: string } };
  assert.equal(json.accepted, true);
  assert.equal(json.equiv.verdict, "PASS");
  assert.ok(json.txId !== undefined);

  const listed = (await get(ui, "/api/readability/suggestions")).json as { suggestions: readonly { readonly kind: string }[]; total: number };
  assert.equal(listed.total, 1);
  assert.equal(listed.suggestions[0]?.kind, "tx");
});

test("GET /api/readability/suggestions: a rewrite/file-op tx carries rendered before/after content, not just paths+hashes (docs/BUGS.md, resolved landing 4d)", async () => {
  const { ui, readability } = baseCtx();
  const res = await post(ui, "/api/readability/actions/combine-files", {
    inputs: ["src/module_1.js", "src/module_2.js"],
    outputs: ["combined.js"],
    evidence: "both files are the same loop helper",
  });
  assert.equal(res.status, 200);

  const listed = (await get(ui, "/api/readability/suggestions")).json as {
    suggestions: readonly { readonly kind: string; readonly newContent?: Record<string, string>; readonly priorContent?: Record<string, string> }[];
  };
  const tx = listed.suggestions.find((s) => s.kind === "tx");
  assert.ok(tx !== undefined);
  // The output path's current tree bytes, read live off `treeDir` -- not a
  // field on the `ReadabilityTransaction` shape itself (the brief: "not to
  // the transaction shape"), just this route's own response enrichment.
  assert.equal(typeof tx!.newContent?.["combined.js"], "string");
  assert.ok(tx!.newContent!["combined.js"]!.length > 0);
  const onDisk = readFileSync(join(readability.context.treeDir, "combined.js"), "utf8");
  assert.equal(tx!.newContent!["combined.js"], onDisk);
  // `combine`'s `prior` covers the whole tree it read to prove
  // tree-equivalence, so `priorContent` is non-empty and includes the two
  // input files' ORIGINAL bytes (the DB-held blob `revert` would restore).
  assert.equal(typeof tx!.priorContent?.["src/module_1.js"], "string");
  assert.ok(tx!.priorContent!["src/module_1.js"]!.length > 0);
});

test("review action: opens with a pending count and no side effect", async () => {
  const backend = new FakeBackend({
    replies: {
      "suggest-name": () => JSON.stringify({ names: [{ bindingId: { fn: 0, reg: 9 }, name: "loopCount", confidence: "high", evidence: "e" }], abstained: false }),
    },
  });
  const { ui } = baseCtx(backend);
  await post(ui, "/api/readability/actions/suggest-names", { fn: 0 });
  const expected = (await get(ui, "/api/readability/suggestions")).json as { total: number };
  const res = await post(ui, "/api/readability/actions/review", {});
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { opened: true, pending: expected.total });
});

test("rewrite-function action: fn is required", async () => {
  const { ui } = baseCtx();
  const res = await post(ui, "/api/readability/actions/rewrite-function", {});
  assert.equal(res.status, 400);
});

