// tests/ui-server/routes.test.ts — docs/specs/22-ui-mvp.md §3 `src/ui-
// server/` (landing 1's own acceptance: "curl every route against
// tests/fixtures/security/vuln-app project"; this rung uses the same
// rn-template-0.72 fixture recipe `tests/mcp/resources.test.ts` and
// `tests/mcp/tools.test.ts` already use, since it is the one with real
// module ranges — see that file's own fixture note). Asserts route
// response shapes equal the direct `McpResources`/`McpTools` call (never a
// literal-string compare against a shared fixture's decompiled output,
// CLAUDE.md / docs/CONSOLIDATION.md §B testing rules).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { dbSetTag } from "../../src/projdb/annotations.ts";
import { McpContext } from "../../src/mcp/context.ts";
import { handle, tailLog, type UiServerCtx } from "../../src/ui-server/routes.ts";
import { listModules, listFunctions } from "../../src/ui-server/list.ts";
import { startUiServer } from "../../src/ui-server/server.ts";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);
const CALLER_FN = 188;
const CALLEE_FN = 190;

function buildFixture(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-ui-server-"));
  const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
  writeSplitResult(splitResult, outDir);
  const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
  const db = openProjectDb(join(outDir, "project.hbcproj"));
  try {
    initProjectDb(db, rows, { actorWho: "test" });
    dbSetTag(db, `fn:${CALLEE_FN}`, "network", { source: "tool", who: "seed" });
  } finally {
    db.close();
  }
  return outDir;
}

const outDir = buildFixture();
test.after(() => rmSync(outDir, { recursive: true, force: true }));

// docs/specs/17-mcp-harness.md §15: ONE `McpContext` — `resources`/`tools`
// below share its `ArtifactService`/`ProjectService` pair, exactly as
// `ctx` (built from the same `McpContext`) does, so a write through
// `tools`/`ctx.tools` is visible to `resources`/`ctx.resources`'s very
// next read with no rebuild step (see the write tests below, which used
// to replicate `server.ts`'s now-deleted rebuild workaround by hand).
const mcpContext = new McpContext(outDir, { hbc: RN_TEMPLATE });
const resources = mcpContext.resources;
const tools = mcpContext.tools;
const ctx: UiServerCtx = { resources, tools, artifactDir: outDir };
const human = { source: "human" as const, who: "analyst@duck.com" };

function get(path: string, query: Record<string, string> = {}) {
  return handle({ method: "GET", path, query, body: undefined }, ctx);
}
function post(path: string, body: unknown) {
  return handle({ method: "POST", path, query: {}, body }, ctx);
}

/** `GET /api/segregation`, polled until the off-main-thread compute
 *  (`src/ui-server/segregation.ts`'s `computeBase`, `node:worker_threads`)
 *  settles — the very first call after this ctx's cache is empty answers
 *  the `computing: true` placeholder rather than blocking (segcache
 *  brief item 3), so tests that assert on the recovered tree's CONTENT
 *  must wait for it exactly as the UI's own poll loop does, rather than
 *  asserting on whichever call happens to land first. */
async function getSegregationSettled() {
  for (let i = 0; i < 200; i++) {
    const r = await get("/api/segregation");
    if (r.status !== 200) return r;
    const body = r.json as { computing?: boolean };
    if (body.computing !== true) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("segregation did not settle off the main thread in time");
}

test("GET /api/fn/:fn matches resources.fn", async () => {
  const r = await get(`/api/fn/${CALLEE_FN}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.fn(CALLEE_FN));
});

test("GET /api/fn/:fn 400s on a non-numeric fn", async () => {
  const r = await get("/api/fn/not-a-number");
  assert.equal(r.status, 400);
  assert.ok((r.json as { reason: string }).reason.length > 0);
});

test("GET /api/fn/:fn/source matches resources.source, ?lines= forwarded", async () => {
  const r = await get(`/api/fn/${CALLEE_FN}/source`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.source(CALLEE_FN));
  const withLines = await get(`/api/fn/${CALLEE_FN}/source`, { lines: "1,2" });
  assert.deepEqual(withLines.json, resources.source(CALLEE_FN, { lines: [1, 2] }));
});

test("GET /api/fn/:fn/disasm matches resources.disasm", async () => {
  const r = await get(`/api/fn/${CALLEE_FN}/disasm`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.disasm(CALLEE_FN));
});

test("GET /api/fn/:fn/linemap agrees with the served source and names real instructions", async () => {
  const r = await get(`/api/fn/${CALLEE_FN}/linemap`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, JSON.parse(JSON.stringify(resources.lineMap(CALLEE_FN))));
  const body = r.json as { fn: number; fnStartLine: number | null; lines: [number, number, number, number][] };
  assert.equal(body.fn, CALLEE_FN);
  // docs/specs/05-emitter.md §16: every row lands inside the text `source`
  // serves for the same function, and the disassembly of the function the row
  // names really has a line starting at that byte offset.
  const sourceLines = resources.source(CALLEE_FN).text.split("\n");
  assert.ok(body.lines.length > 0, "the rn-template fixture function should map at least one line");
  for (const [line, fn, start] of body.lines) {
    assert.ok(line >= 1 && line <= sourceLines.length, `line ${line} outside the ${sourceLines.length}-line source`);
    assert.ok(resources.disasm(fn).text.includes(`[@ ${start}]`), `fn ${fn} disasm has no instruction at @${start}`);
  }
});

test("GET /api/fn/:fn/linemap rejects a non-numeric fn", async () => {
  const r = await get("/api/fn/nope/linemap");
  assert.equal(r.status, 400);
});

test("GET /api/fn/:fn/context forwards include/depth", async () => {
  const r = await get(`/api/fn/${CALLEE_FN}/context`, { include: "metadata,callers", depth: "2" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.context(CALLEE_FN, { include: ["metadata", "callers"], depth: 2 }));
});

test("GET /api/fn/:fn/callers matches resources.whoCalls and inlines {fn,name,size}", async () => {
  const r = await get(`/api/fn/${CALLEE_FN}/callers`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.whoCalls(CALLEE_FN));
  const rows = (r.json as { rows: readonly { fn: number }[] }).rows;
  assert.ok(rows.some((row) => row.fn === CALLER_FN));
});

test("GET /api/fn/:fn/callees matches resources.callsFrom", async () => {
  const r = await get(`/api/fn/${CALLER_FN}/callees`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.callsFrom(CALLER_FN));
});

test("GET /api/fn/:fn/annotations matches resources.annotationsForFn", async () => {
  const r = await get(`/api/fn/${CALLEE_FN}/annotations`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.annotationsForFn(CALLEE_FN));
});

test("GET /api/module/:id matches resources.module", async () => {
  const modules = listModules(outDir);
  assert.ok(modules.rows.length > 0);
  const id = modules.rows[0]!.id;
  const r = await get(`/api/module/${id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.module(id));
});

test("GET /api/module/:id/source returns the whole file + owned fn ranges (file view)", async () => {
  const mod = resources.fn(CALLEE_FN).module;
  assert.ok(mod !== null);
  const r = await get(`/api/module/${mod}/source`);
  assert.equal(r.status, 200);
  const body = r.json as { module: number; file: string; text: string; functions: readonly { fn: number; lines: readonly [number, number] }[] };
  assert.equal(body.module, mod);
  assert.equal(body.text.split("\n").length >= Math.max(...body.functions.map((f) => f.lines[1])), true);
  const own = body.functions.find((f) => f.fn === CALLEE_FN);
  assert.ok(own !== undefined, "the module's function list includes the fixture's callee fn");
  // the range slice of the file IS the function's own source route
  const slice = body.text.split("\n").slice(own!.lines[0] - 1, own!.lines[1]).join("\n");
  assert.equal(slice, ((await get(`/api/fn/${CALLEE_FN}/source`)).json as { text: string }).text);
  for (let i = 1; i < body.functions.length; i++) assert.ok(body.functions[i]!.lines[0] >= body.functions[i - 1]!.lines[0], "sorted by start line");
  assert.equal((await get("/api/module/999999/source")).status, 404);
});

test("GET /api/modules lists every module (own list layer, not resources.ts)", async () => {
  const r = await get("/api/modules");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, listModules(outDir));
  const body = r.json as { rows: readonly unknown[]; total: number };
  assert.ok(body.rows.length > 0);
  assert.equal(body.total, body.rows.length);
});

test("GET /api/functions pages {fn,name,size,module}", async () => {
  const r = await get("/api/functions");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, listFunctions(resources.artifact, 0));
  const body = r.json as { rows: readonly { fn: number; name: unknown; size: unknown; module: unknown }[] };
  assert.ok(body.rows.length > 0);
  for (const row of body.rows) assert.ok("fn" in row && "name" in row && "size" in row && "module" in row);
});

test("GET /api/functions?limit= raises the page size, clamped to FUNCTIONS_PAGE_MAX", async () => {
  const r = await get("/api/functions", { limit: "1000" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, listFunctions(resources.artifact, 0, 1000));
  const body = r.json as { rows: readonly unknown[]; total: number };
  // Proves a big ?limit= does not silently fall back to the 50-row default
  // (the bug this route change fixes: `ui/src/hooks.ts`'s
  // useFunctionCatalogue used to walk 50 rows a page, capping the whole
  // catalogue at 200*50=10,000 — less than Service NSW's ~15,000
  // functions).
  assert.equal(body.rows.length, Math.min(1000, body.total));
  assert.ok(body.rows.length > 50, `expected more than one 50-row default page, saw ${body.rows.length}`);

  const over = await get("/api/functions", { limit: "999999" });
  assert.equal(over.status, 200);
  assert.deepEqual(over.json, listFunctions(resources.artifact, 0, 1000), "limit clamps to FUNCTIONS_PAGE_MAX, not a 400");

  const bad = await get("/api/functions", { limit: "not-a-number" });
  assert.equal(bad.status, 200, "a nonsense limit falls back to the default page size rather than erroring");
});

test("GET /api/search/functions matches resources.searchFunctions", async () => {
  const r = await get("/api/search/functions", { q: "e" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.searchFunctions("e"));
});

test("GET /api/search/functions 400s with no ?q=", async () => {
  const r = await get("/api/search/functions");
  assert.equal(r.status, 400);
});

test("GET /api/search/source matches resources.searchSource", async () => {
  const r = await get("/api/search/source", { q: "function" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.searchSource("function"));
});

test("GET /api/xref/string mode=exact matches resources.xrefString", async () => {
  const r = await get("/api/xref/string", { key: "69", mode: "exact" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.xrefString(69, "exact"));
  const body = r.json as { uses: { rows: { name: string | null; size: number | null }[] } };
  for (const row of body.uses.rows) assert.ok("name" in row && "size" in row);
});

test("GET /api/xref/string mode=substring matches resources.xrefString", async () => {
  const r = await get("/api/xref/string", { key: "value", mode: "substring" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.xrefString("value", "substring"));
});

test("GET /api/xref/global matches resources.globalUses", async () => {
  const r = await get("/api/xref/global", { name: "require" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.globalUses("require"));
  const body = r.json as { rows: { name: string | null; size: number | null }[] };
  for (const row of body.rows) assert.ok("name" in row && "size" in row);
});

test("GET /api/xref/who-calls-by-name (?name=) matches resources.whoCallsByName", async () => {
  const r = await get("/api/xref/who-calls-by-name", { name: "sendAccessibilityEvent" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.whoCallsByName({ name: "sendAccessibilityEvent" }));
});

test("GET /api/xref/who-calls-by-name (?fn=) matches resources.whoCallsByName", async () => {
  const r = await get("/api/xref/who-calls-by-name", { fn: "180" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.whoCallsByName({ fn: 180 }));
});

test("GET /api/xref/who-calls-by-name with neither fn nor name is a 400", async () => {
  const r = await get("/api/xref/who-calls-by-name", {});
  assert.equal(r.status, 400);
});

test("GET /api/native matches resources.native", async () => {
  const r = await get("/api/native");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.native());
});

test("GET /api/leads and /api/leads/security-sinks match resources", async () => {
  const r1 = await get("/api/leads");
  assert.deepEqual(r1.json, resources.leads());
  const r2 = await get("/api/leads/security-sinks");
  assert.deepEqual(r2.json, resources.securitySinks());
});

test("GET /api/findings matches resources.findings", async () => {
  const r = await get("/api/findings");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.findings());
});

test("GET /api/finding/:rid 404s on an unknown rid", async () => {
  const r = await get("/api/finding/no-such-rid");
  assert.equal(r.status, 404);
});

test("GET /api/scan/secrets matches resources.scanSecrets", async () => {
  const r = await get("/api/scan/secrets");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.scanSecrets());
});

test("GET /api/log matches resources.log", async () => {
  const r = await get("/api/log");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.log());
});

test("GET /api/history/:target matches resources.history", async () => {
  const r = await get(`/api/history/fn:${CALLEE_FN}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, resources.history(`fn:${CALLEE_FN}`));
});

test("write route (set-name) lands a log row visible via GET /api/log/tail", async () => {
  const before = tailLog(ctx.resources, 0).cursor;
  const target = `fn:${CALLER_FN}`;
  const w = await post("/api/tools/set-name", { target, name: "verifyPayload", prov: human });
  assert.equal(w.status, 200);
  const body = w.json as { rid: string; line: string };
  assert.ok(body.line.includes("verifyPayload"));

  const tail = await get("/api/log/tail", { since: String(before) });
  assert.equal(tail.status, 200);
  const tailBody = tail.json as { rows: readonly { op: string; detail: string | null }[]; cursor: number };
  assert.ok(tailBody.cursor > before);
  assert.ok(tailBody.rows.some((row) => row.op === "annotate" && row.detail !== null && JSON.parse(row.detail).kind === "name"));
});

test("write routes (add-comment, add-tag, record-finding, set-finding-status) round-trip", async () => {
  const target = `fn:${CALLEE_FN}`;
  const c = await post("/api/tools/add-comment", { target, body: "looks suspicious", prov: human });
  assert.equal(c.status, 200);
  const t = await post("/api/tools/add-tag", { target, tag: "suspicious", prov: human });
  assert.equal(t.status, 200);
  const f = await post("/api/tools/record-finding", {
    class: "high",
    location: { fn: CALLEE_FN },
    claim: "ui-server route test finding",
    evidence: [{ ref: target, role: "primary" }],
    prov: human,
  });
  assert.equal(f.status, 200);
  const rid = (f.json as { rid: string }).rid;

  const shown = await get(`/api/finding/${rid}`);
  assert.equal(shown.status, 200);
  assert.deepEqual(shown.json, ctx.resources.finding(rid));

  const dynamicRef = "fuzz:tests/fixtures/bundles/rn-template-0.72/index.android.hbc";
  const s = await post("/api/tools/set-finding-status", { findingRid: rid, to: "confirmed", evidence: [{ ref: dynamicRef, role: "dynamic" }], prov: human });
  assert.equal(s.status, 200);
});

test("POST /api/tools/record-finding 400s on truth-rule violation (no resolving evidence)", async () => {
  const r = await post("/api/tools/record-finding", {
    class: "low",
    location: { fn: CALLEE_FN },
    claim: "no evidence at all",
    evidence: [],
    prov: human,
  });
  assert.equal(r.status, 400);
  assert.ok(/evidence/i.test((r.json as { reason: string }).reason));
});

test("POST /api/tools/request-fidelity-check and /api/tools/generate-documentation route through", async () => {
  const fc = await post("/api/tools/request-fidelity-check", { fn: CALLEE_FN, oracles: ["syntax"] });
  assert.equal(fc.status, 200);
  assert.ok(typeof (fc.json as { verdict: string }).verdict === "string");
  const doc = await post("/api/tools/generate-documentation", {});
  assert.equal(doc.status, 200);
  assert.ok(typeof (doc.json as { report: string }).report === "string");
});

test("POST /api/tools/recompile-edit returns the warning verbatim + watermark", async () => {
  const source = "function patched(a, b) { return a + b; }\nprint(patched(1, 2));\n";
  const r = await post("/api/tools/recompile-edit", { fn: CALLER_FN, source, prov: human });
  assert.equal(r.status, 200);
  const body = r.json as { warning: string; watermark: { kind: string } };
  assert.ok(body.warning.length > 0);
  assert.equal(body.watermark.kind, "edited-and-recompiled");
});

test("unknown route 404s", async () => {
  const r = await get("/api/no-such-thing");
  assert.equal(r.status, 404);
});

// -- SSE: a real listening server (spec 22 §1's own default: localhost,
// one process) on port 0, receiving a `log` event after a write --------
test("GET /api/events forwards a log event after a set-name write", async () => {
  const ssOutDir = buildFixture();
  try {
    const handle2 = await startUiServer({ projectDir: ssOutDir, hbc: RN_TEMPLATE, port: 0, host: "127.0.0.1" });
    try {
      const es = await fetch(`http://127.0.0.1:${handle2.port}/api/events`);
      assert.equal(es.status, 200);
      const reader = es.body!.getReader();
      const decoder = new TextDecoder();

      const gotLogEvent = (async () => {
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return false;
          buf += decoder.decode(value, { stream: true });
          if (buf.includes("event: log")) return true;
        }
      })();

      // give the SSE connection a moment to be established, then write.
      await new Promise((r) => setTimeout(r, 100));
      const wr = await fetch(`http://127.0.0.1:${handle2.port}/api/tools/set-name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: `fn:${CALLER_FN}`, name: "sseProbe", prov: human }),
      });
      assert.equal(wr.status, 200);

      const timeout = new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 5000));
      const got = await Promise.race([gotLogEvent, timeout]);
      await reader.cancel().catch(() => {});
      assert.equal(got, true, "expected a `log` SSE event within 5s of a write");
    } finally {
      await handle2.close();
    }
  } finally {
    rmSync(ssOutDir, { recursive: true, force: true });
  }
});

test("GET /api/modules is not truncated below a real app's module count (Service NSW: 4,510)", async () => {
  // regression: CAP_MODULES was 500, so the tree showed 500 of 4,510 modules.
  const r = await get("/api/modules");
  const body = r.json as { rows: readonly unknown[]; total: number; truncated: boolean };
  assert.equal(body.truncated, false);
  assert.equal(body.rows.length, body.total);
  const { CAP_MODULES } = await import("../../src/ui-server/list.ts");
  assert.ok(CAP_MODULES >= 5000, `CAP_MODULES ${CAP_MODULES} must cover a 4,510-module app`);
});

// -- GET /api/segregation (the screens-first tree's source) -------------------
// A real Metro bundle has no module paths, so the tree cannot group by
// `ModuleEntry.file`; it groups by the name-recovery pass instead
// (src/ui-server/segregation.ts over src/split/segregate.ts). These assert
// route-owned properties only — coverage of the module set, the shape of a
// row, the counts' disjointness and the cache — never the recovered names
// themselves, which belong to segregate.ts's own tests.

test("GET /api/segregation covers every module in /api/modules exactly once", async () => {
  const r = await getSegregationSettled();
  assert.equal(r.status, 200);
  const body = r.json as { modules: readonly { id: number; path: string; bucket: string; package: string | null }[]; counts: Record<string, number> };
  const ids = body.modules.map((m) => m.id);
  assert.deepEqual([...ids].sort((a, b) => a - b), ids, "rows must be sorted by id");
  assert.equal(new Set(ids).size, ids.length, "no module id may appear twice");
  const listed = listModules(outDir).rows.map((m) => m.id);
  assert.ok(listed.length > 0, "sanity: the fixture has modules");
  assert.deepEqual([...ids].sort((a, b) => a - b), [...listed].sort((a, b) => a - b));
});

test("GET /api/segregation rows carry a non-empty path and a known bucket", async () => {
  const body = (await getSegregationSettled()).json as { modules: readonly { id: number; path: string; bucket: string }[] };
  const buckets = new Set(["src", "node_modules", "unclassified"]);
  for (const m of body.modules) {
    assert.ok(m.path.length > 0, `module ${m.id} has an empty path`);
    assert.ok(buckets.has(m.bucket), `module ${m.id} has bucket ${m.bucket}`);
    assert.ok(m.path.includes(`module_${m.id}`) || /\.js$/.test(m.path), `module ${m.id} path ${m.path} is not a module file`);
  }
});

test("GET /api/segregation counts are disjoint and total the module count", async () => {
  const body = (await getSegregationSettled()).json as {
    modules: readonly { path: string; bucket: string }[];
    counts: { screens: number; navigation: number; src: number; node_modules: number; unclassified: number };
  };
  const c = body.counts;
  assert.equal(c.screens + c.navigation + c.src + c.node_modules + c.unclassified, body.modules.length);
  assert.equal(c.screens, body.modules.filter((m) => m.path.startsWith("src/screens/")).length);
  assert.equal(c.navigation, body.modules.filter((m) => m.path.startsWith("src/navigation/")).length);
  assert.equal(c.node_modules, body.modules.filter((m) => m.bucket === "node_modules").length);
  assert.equal(c.unclassified, body.modules.filter((m) => m.bucket === "unclassified").length);
});

test("GET /api/package-id/:mod matches resources.packageId's shape (available:false or true with a reason/evidence string)", async () => {
  const r = await get("/api/package-id/0");
  assert.equal(r.status, 200);
  const body = r.json as { available: boolean; mod: number; reason?: string; package?: string };
  assert.equal(body.mod, 0);
  if (body.available) {
    assert.equal(typeof body.package, "string");
  } else {
    assert.equal(typeof body.reason, "string");
    assert.ok(body.reason!.length > 0);
  }
  const direct = await resources.packageId(0);
  assert.deepEqual(body, direct);
});

test("GET /api/package-id/:mod 400s on a non-numeric module id", async () => {
  const r = await get("/api/package-id/not-a-number");
  assert.equal(r.status, 400);
  assert.match((r.json as { reason: string }).reason, /package-id/);
});

test("GET /api/segregation carries depsApplied, and settles from false to true without a second explicit request cycle", async () => {
  const fresh: UiServerCtx = { resources: mcpContext.resources, tools, artifactDir: outDir };
  const first = (await handle({ method: "GET", path: "/api/segregation", query: {}, body: null }, fresh)).json as { depsApplied: boolean };
  assert.equal(typeof first.depsApplied, "boolean");
  // The async deps recompute (`applyDepsWhenReady`) was kicked off by that
  // first call; give it a chance to settle rather than asserting a fixed
  // value — `depsApplied` must eventually reach `true` for a ctx with an
  // `--hbc` bundle configured (this fixture's `mcpContext` has one).
  let settled = first.depsApplied;
  for (let i = 0; i < 50 && !settled; i++) {
    await new Promise((res) => setTimeout(res, 50));
    const poll = (await handle({ method: "GET", path: "/api/segregation", query: {}, body: null }, fresh)).json as { depsApplied: boolean };
    settled = poll.depsApplied;
  }
  assert.equal(settled, true, "depsApplied must settle to true so the UI's poll loop terminates");
});

test("segregation is computed once per ctx and served from cache after that", async () => {
  const { segregation, segregationCached, moduleDirOf } = await import("../../src/ui-server/segregation.ts");
  assert.notEqual(moduleDirOf(outDir), null, "the fixture must hold module_<id>.js files somewhere");
  const fresh: UiServerCtx = { resources, tools, artifactDir: outDir };
  assert.equal(segregationCached(fresh), false, "nothing is computed until the first request");
  let first = segregation(fresh);
  assert.notEqual(first, null);
  // Settles either straight from the persisted DB cache (sub-ms) or off
  // the main thread via the worker (segcache brief item 3) — either way
  // `segregation()` never blocks, so the first call may return the
  // `computing: true` placeholder; poll rather than assume it lands on the
  // very first call.
  for (let i = 0; i < 200 && first?.computing === true; i++) {
    await new Promise((r) => setTimeout(r, 20));
    first = segregation(fresh);
  }
  assert.notEqual(first?.computing, true, "segregation did not settle in time");
  assert.equal(segregationCached(fresh), true);
  assert.equal(segregation(fresh), first, "the second call must return the SAME object, not recompute");
});

test("GET /api/segregation 404s for a project with no module files", async () => {
  const empty = mkdtempSync(join(tmpdir(), "hbc2js-ui-server-empty-"));
  try {
    const r = await handle({ method: "GET", path: "/api/segregation", query: {}, body: null }, { resources, tools, artifactDir: empty });
    assert.equal(r.status, 404);
    assert.match((r.json as { reason: string }).reason, /segregat/i);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("the server warms the segregation cache at startup, so the first tree request is instant", async () => {
  const { segregationCached } = await import("../../src/ui-server/segregation.ts");
  const h = await startUiServer({ projectDir: outDir, hbc: RN_TEMPLATE, port: 0, workers: false });
  try {
    assert.equal(typeof h.ctx.artifactDir, "string", "the handle must expose the ctx routes run against");
    // `setImmediate` fires after the listen callback and starts the
    // compute; by this point in the suite `outDir`'s project DB already
    // holds a persisted cache from the earlier segregation tests above, so
    // the warm-up settles from the DB (sub-ms) rather than spawning a
    // worker — poll briefly rather than assume one macrotask is enough,
    // since `segregation()` no longer computes synchronously (item 3).
    let settled = false;
    for (let i = 0; i < 100 && !settled; i++) {
      await new Promise((r) => setTimeout(r, 20));
      settled = segregationCached(h.ctx);
    }
    assert.equal(settled, true, "startup must not leave the first browser request to pay for segregation");
    const started = Date.now();
    const r = await fetch(`http://${h.host}:${h.port}/api/segregation`);
    assert.equal(r.status, 200);
    assert.ok(Date.now() - started < 1000, `a warmed /api/segregation must answer fast, took ${Date.now() - started}ms`);
  } finally {
    await h.close();
  }
});

test("GET /api/segregation reports computing:true while a cold, un-persisted compute is in flight, then settles", async () => {
  const outDir2 = mkdtempSync(join(tmpdir(), "hbc2js-ui-server-seg2-"));
  try {
    const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
    writeSplitResult(splitResult, outDir2);
    const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
    const db2 = openProjectDb(join(outDir2, "project.hbcproj"));
    initProjectDb(db2, rows, { actorWho: "test" });
    db2.close();
    const mcp2 = new McpContext(outDir2);
    const fresh: UiServerCtx = { resources: mcp2.resources, tools: mcp2.tools, artifactDir: outDir2 };
    const first = (await handle({ method: "GET", path: "/api/segregation", query: {}, body: null }, fresh)).json as {
      computing?: boolean;
      modules: readonly unknown[];
      depsApplied: boolean;
    };
    assert.equal(first.computing, true, "a fresh ctx with no persisted cache must answer computing:true, not block");
    assert.deepEqual(first.modules, [], "the placeholder carries the empty fallback shape");
    assert.equal(first.depsApplied, false);
    let settled: { computing?: boolean } = first;
    for (let i = 0; i < 200 && settled.computing === true; i++) {
      await new Promise((r) => setTimeout(r, 20));
      settled = (await handle({ method: "GET", path: "/api/segregation", query: {}, body: null }, fresh)).json as { computing?: boolean };
    }
    assert.notEqual(settled.computing, true, "the worker compute must eventually settle");
  } finally {
    rmSync(outDir2, { recursive: true, force: true });
  }
});

test("GET /api/segregation is served from the persisted cache without recomputing on a second ctx over the same project dir", async () => {
  const { segregation, segregationCached } = await import("../../src/ui-server/segregation.ts");
  // `outDir` already has a persisted cache from the tests above; a BRAND
  // NEW ctx over the same directory must load it (reusing the shared
  // `resources`/`tools` — `segregation()` never needs them to be bound to
  // `outDir` itself, exactly like the "no module files" test above) and
  // settle FAST from the DB — `segregation()` is still fire-and-forget on
  // its very first call for any ctx (never blocks), so poll briefly rather
  // than assert no `computing:true` window is ever observed.
  const another: UiServerCtx = { resources, tools, artifactDir: outDir };
  let r = segregation(another);
  for (let i = 0; i < 50 && r?.computing === true; i++) {
    await new Promise((res) => setTimeout(res, 5));
    r = segregation(another);
  }
  assert.notEqual(r, null);
  assert.notEqual(r?.computing, true, "a persisted cache hit must settle fast, without spawning a worker");
  assert.equal(segregationCached(another), true);
});

test("segregation() is a no-op-persistence, never-error path for a --split artifact with no project.hbcproj", async () => {
  const splitOnly = mkdtempSync(join(tmpdir(), "hbc2js-ui-server-splitonly-"));
  try {
    const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
    writeSplitResult(splitResult, splitOnly);
    assert.ok(!existsSync(join(splitOnly, "project.hbcproj")), "sanity: no project DB here");
    // Reuses the shared `resources`/`tools` (bound to `outDir`), same trick
    // as the "no module files" test above — `segregation()` only reads
    // `ctx.artifactDir` for the module tree/DB path, never `resources`'s
    // own artifact directory.
    const fresh: UiServerCtx = { resources, tools, artifactDir: splitOnly };
    let r = (await handle({ method: "GET", path: "/api/segregation", query: {}, body: null }, fresh)).json as
      | { computing?: boolean }
      | { reason: string };
    for (let i = 0; i < 200 && "computing" in r && r.computing === true; i++) {
      await new Promise((res) => setTimeout(res, 20));
      r = (await handle({ method: "GET", path: "/api/segregation", query: {}, body: null }, fresh)).json as { computing?: boolean } | { reason: string };
    }
    assert.ok(!("computing" in r) || r.computing !== true, "must settle even with no DB to persist into");
  } finally {
    rmSync(splitOnly, { recursive: true, force: true });
  }
});
