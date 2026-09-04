// tests/ui-server/events-bus.test.ts — spec 26 L1's acceptance tests for the
// in-process write bus + `/api/events` doorbell (spec 21 §1.2/§1.3): a write
// through the shared `McpContext` shows up on the SSE stream within one
// event-loop turn, not on the next 500 ms poll tick, and the log stays the
// authority a client can always fall back to (a "missed" doorbell still
// converges by tailing).
//
// Same fixture recipe as tests/ui-server/routes.test.ts (rn-template-0.72,
// via `cachedSplitProject`) — a real project, not a mock.
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
import { tailLog } from "../../src/ui-server/routes.ts";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);
const CALLER_FN = 188;
const human = { source: "human" as const, who: "events-bus-test" };

function buildFixture(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-events-bus-"));
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

async function withServer<T>(fn: (h: Awaited<ReturnType<typeof startUiServer>>) => Promise<T>): Promise<T> {
  const outDir = buildFixture();
  try {
    const h = await startUiServer({ projectDir: outDir, hbc: RN_TEMPLATE, port: 0, host: "127.0.0.1", workers: false, prewarm: false });
    try {
      return await fn(h);
    } finally {
      await h.close();
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

test("/api/events emits within 50 ms of a write, not on the poll tick", async () => {
  await withServer(async (h) => {
    const es = await fetch(`http://127.0.0.1:${h.port}/api/events`);
    assert.equal(es.status, 200);
    const reader = es.body!.getReader();
    const decoder = new TextDecoder();

    let sawLogAt: number | undefined;
    const watcher = (async () => {
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        if (sawLogAt === undefined && buf.includes("event: log")) {
          sawLogAt = Date.now();
          return;
        }
      }
    })();

    // Give the SSE connection a moment to actually be attached before firing
    // the write, or the write could race the `GET` itself.
    await new Promise((r) => setTimeout(r, 100));
    const wroteAt = Date.now();
    const wr = await fetch(`http://127.0.0.1:${h.port}/api/tools/set-name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: `fn:${CALLER_FN}`, name: "doorbellProbe", prov: human }),
    });
    assert.equal(wr.status, 200);

    const timeout = new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2000));
    await Promise.race([watcher, timeout]);
    await reader.cancel().catch(() => {});

    assert.ok(sawLogAt !== undefined, "expected a `log` SSE event after the write");
    const elapsed = sawLogAt! - wroteAt;
    // `SSE_POLL_MS` (server.ts) is 500 — well under it proves the doorbell
    // fired the check, not the fallback tick. A generous bound vs. the
    // spec's own "50 ms" framing to absorb CI scheduling jitter.
    assert.ok(elapsed < 300, `expected well under the 500ms poll tick, got ${elapsed}ms`);
  });
});

test("a missed doorbell still converges: replay from the cursor yields the same rows", async () => {
  await withServer(async (h) => {
    // Nobody is listening on /api/events for either of these writes — the
    // exact "doorbell missed" case (a reconnecting client, or a second
    // process with no access to this in-process bus at all, spec 21 §1.3).
    const before = tailLog(h.ctx.resources, 0).cursor;
    const r1 = await fetch(`http://127.0.0.1:${h.port}/api/tools/set-name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: `fn:${CALLER_FN}`, name: "missedDoorbell1", prov: human }),
    });
    assert.equal(r1.status, 200);
    const r2 = await fetch(`http://127.0.0.1:${h.port}/api/tools/add-comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: `fn:${CALLER_FN}`, body: "missed doorbell probe", prov: human }),
    });
    assert.equal(r2.status, 200);

    // A late-arriving replay from the pre-write cursor sees both writes, in
    // order, exactly as if it had been live the whole time.
    const replayed = tailLog(h.ctx.resources, before);
    assert.ok(replayed.rows.length >= 2, `expected >=2 rows, got ${replayed.rows.length}`);
    const seqs = replayed.rows.map((r) => r.seq);
    assert.deepEqual([...seqs], [...seqs].sort((a, b) => a - b));

    // The exact same read via the HTTP route (a fresh `/api/events`
    // connection's own catch-up path, `?since=`) converges identically.
    const tailResp = await fetch(`http://127.0.0.1:${h.port}/api/log/tail?since=${before}`);
    assert.equal(tailResp.status, 200);
    const tailBody = (await tailResp.json()) as { rows: readonly { seq: number }[]; cursor: number };
    assert.deepEqual(tailBody.rows.map((r) => r.seq), replayed.rows.map((r) => r.seq));
    assert.equal(tailBody.cursor, replayed.cursor);
  });
});

test("the frame's targets match the log entries' targets", async () => {
  await withServer(async (h) => {
    const before = tailLog(h.ctx.resources, 0).cursor;
    const r = await fetch(`http://127.0.0.1:${h.port}/api/tools/set-name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: `fn:${CALLER_FN}`, name: "targetsProbe", prov: human }),
    });
    assert.equal(r.status, 200);

    const tailResp = await fetch(`http://127.0.0.1:${h.port}/api/log/tail?since=${before}`);
    const tailBody = (await tailResp.json()) as { rows: readonly { detail: string | null }[]; targets: readonly string[] };
    assert.ok(tailBody.rows.length > 0);

    const expected = new Set<string>();
    for (const row of tailBody.rows) {
      if (row.detail === null) continue;
      const parsed = JSON.parse(row.detail) as { target?: string };
      if (typeof parsed.target === "string") expected.add(parsed.target);
    }
    assert.ok(expected.has(`fn:${CALLER_FN}`), `expected the write's own row to name fn:${CALLER_FN}`);
    assert.deepEqual([...tailBody.targets].sort(), [...expected].sort());
  });
});
