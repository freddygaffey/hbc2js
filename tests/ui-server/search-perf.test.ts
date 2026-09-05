// tests/ui-server/search-perf.test.ts -- acceptance for the "GET
// /api/search/source freezes the whole ui-server" bug (docs/BUGS.md
// "search/source blocks the ui-server" row; QA measured 83 s on a real
// 12 MB app, during which seven /api/jobs probes issued over 70 s all
// timed out and then completed in 0 ms the instant the search returned).
//
// The property under test is NOT "the search is fast" (that is the bundle's
// size, not ours) -- it is that the ui-server's single thread stays
// answerable WHILE a bundle-wide search runs, and that an explicit `?limit=`
// stops the scan early instead of scanning everything and then slicing.
// Same rn-template-0.72 fixture recipe as `routes.test.ts`; rung-owned
// assertions only (timings, counts, structure -- never a literal-string
// compare against a shared fixture's decompiled output).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { startUiServer } from "../../src/ui-server/server.ts";
import { McpResources } from "../../src/mcp/resources.ts";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);

const outDir = mkdtempSync(join(tmpdir(), "hbc2js-search-perf-"));
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

// A query that matches a lot of lines in a real bundle, so the scan is a
// real bundle-wide walk rather than an early miss.
const BROAD = "function";

test("searchSourceAsync hands the event loop back while it scans (the whole point)", async () => {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 5);
  let page;
  try {
    page = await res.searchSourceAsync(BROAD);
  } finally {
    clearInterval(timer);
  }
  assert.ok(page.rows.length > 0, "the fixture must actually match, or this proves nothing");
  assert.ok(ticks > 0, `the event loop never ran during the scan (${ticks} timer ticks) -- the search is still blocking`);
});

test("searchSourceAsync returns exactly what the synchronous scan returns", async () => {
  assert.deepEqual(await res.searchSourceAsync(BROAD), res.searchSource(BROAD));
  assert.deepEqual(await res.searchSourceAsync("zzz-no-such-token-anywhere"), res.searchSource("zzz-no-such-token-anywhere"));
});

test("search/source pushes ?limit= down into the scan: a bounded query stops early", () => {
  const full = res.searchSource(BROAD);
  const bounded = res.searchSource(BROAD, { limit: 5 });
  assert.equal(bounded.rows.length, 5);
  // Same rows as the first five of the exhaustive scan -- stopping early
  // must not reorder or skip anything.
  assert.deepEqual(bounded.rows, full.rows.slice(0, 5));
  assert.equal(bounded.nextCursor, 5);
  assert.equal(bounded.partial, true, "an early-stopped scan must say so; its `total` is only a lower bound");
  assert.ok(bounded.total < full.total, "a bounded query must not have counted every match in the bundle");
  assert.ok(bounded.total >= bounded.rows.length);
});

test("an exhaustive search/source (no ?limit=) still reports the exact match count", () => {
  const full = res.searchSource(BROAD);
  assert.equal(full.partial, undefined, "a complete scan must never claim to be partial");
  assert.equal(full.total, res.searchSource(BROAD, { cursor: 0 }).total);
  const page2 = res.searchSource(BROAD, { cursor: full.nextCursor ?? 0 });
  assert.equal(page2.total, full.total, "paging must not change the total");
});

test("?limit= only ever narrows a page, never widens the cap", () => {
  assert.ok(res.searchSource(BROAD, { limit: 10_000 }).rows.length <= 50);
  assert.equal(res.searchSource(BROAD, { limit: 0 }).rows.length, res.searchSource(BROAD).rows.length);
});

// A regex query whose scan is ~0.8 s on this fixture (83k matching lines):
// answered inline it holds the thread for that long, which is exactly the
// stall the bug is about, scaled down from the 83 s a 12 MB app showed.
const HEAVY = "(?:[A-Za-z]+[0-9]*){1,4}[.]";

test("the ui-server keeps answering other routes while a search is in flight", async () => {
  const h = await startUiServer({ projectDir: outDir, hbc: RN_TEMPLATE, port: 0, host: "127.0.0.1", workers: false, noAuth: true });
  const base = `http://127.0.0.1:${h.port}`;
  try {
    // Warm the probe route first: the very first `/api/functions` on a
    // fresh server pays the artifact index load, and this test measures
    // QUEUEING BEHIND THE SEARCH, not cold start.
    await fetch(`${base}/api/functions?limit=1`);
    let pending = 0;
    const searches: Promise<unknown>[] = [];
    for (let i = 0; i < 2; i++) {
      pending++;
      searches.push(
        fetch(`${base}/api/search/source?regex=1&q=${encodeURIComponent(HEAVY)}`)
          .then((r) => r.json())
          .finally(() => {
            pending--;
          }),
      );
    }
    // Give the searches a turn to reach the server and start scanning.
    await new Promise((r) => setTimeout(r, 30));
    const t0 = performance.now();
    const r = await fetch(`${base}/api/functions?limit=1`);
    const ms = performance.now() - t0;
    assert.equal(r.status, 200);
    assert.ok(pending > 0, "the searches finished before the probe -- this run proved nothing");
    assert.ok(ms < 200, `/api/functions took ${ms.toFixed(0)}ms while a search was in flight -- the main thread is blocked`);
    for (const page of (await Promise.all(searches)) as { rows: unknown[] }[]) assert.ok(page.rows.length > 0);
  } finally {
    await h.close();
  }
});

test("GET /api/template-injections answers off the critical path and honours ?limit=", async () => {
  const h = await startUiServer({ projectDir: outDir, hbc: RN_TEMPLATE, port: 0, host: "127.0.0.1", workers: false, noAuth: true });
  const base = `http://127.0.0.1:${h.port}`;
  try {
    let done = false;
    const scan = fetch(`${base}/api/template-injections?limit=2`)
      .then((r) => r.json())
      .finally(() => {
        done = true;
      });
    await new Promise((r) => setTimeout(r, 5));
    const t0 = performance.now();
    const probe = await fetch(`${base}/api/functions?limit=1`);
    const ms = performance.now() - t0;
    assert.equal(probe.status, 200);
    const body = (await scan) as { rows: unknown[]; total: number };
    assert.ok(Array.isArray(body.rows));
    assert.ok(body.rows.length <= 2, `?limit=2 returned ${body.rows.length} rows`);
    if (!done) assert.ok(ms < 200, `/api/functions took ${ms.toFixed(0)}ms while the injection scan ran -- the main thread is blocked`);
  } finally {
    await h.close();
  }
});
