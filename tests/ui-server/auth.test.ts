// tests/ui-server/auth.test.ts — spec 26 L2 (docs/specs/26-ui-full-ide.md):
// loopback auth. Every `startUiServer` run mints a per-process bearer token
// unless started with `noAuth: true`; every `/api/*` route (checked in
// `src/ui-server/server.ts`, ahead of `handle()`/`serveEvents`) demands it
// either as `Authorization: Bearer <token>` or `?token=<token>` (the form a
// browser's native `EventSource` must use, since it cannot set headers).
// `origin` narrows CORS to one exact origin instead of the loopback-any
// default. Uses the smallest fixture bytecode in the repo (`04-for-loop-
// basic`, the same one `tests/ui-server/warm-frames.test.ts` uses) — this
// suite never needs a real decompile, only the HTTP layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { splitProject } from "../../src/split/index.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { startUiServer } from "../../src/ui-server/server.ts";

const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v96.hbc");
const bytes = readFileSync(FIXTURE_HBC);
const splitResult = splitProject(bytes, { moduleName: "04-for-loop-basic" });

function buildArtifact(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-ui-auth-"));
  writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
  return outDir;
}

test("a request without the token is 401", async () => {
  const outDir = buildArtifact();
  const h = await startUiServer({ projectDir: outDir, port: 0, host: "127.0.0.1", workers: false, prewarm: false });
  try {
    assert.equal(typeof h.token, "string", "auth is ON by default: a token must be minted");
    const r = await fetch(`http://${h.host}:${h.port}/api/modules`);
    assert.equal(r.status, 401);
    const json = (await r.json()) as { reason?: unknown };
    assert.equal(typeof json.reason, "string");
  } finally {
    await h.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("the token from the launch URL is accepted", async () => {
  const outDir = buildArtifact();
  const h = await startUiServer({ projectDir: outDir, port: 0, host: "127.0.0.1", workers: false, prewarm: false });
  try {
    // The ordinary form every plain `fetch` in ui/src/ sends.
    const viaHeader = await fetch(`http://${h.host}:${h.port}/api/modules`, {
      headers: { Authorization: `Bearer ${h.token}` },
    });
    assert.equal(viaHeader.status, 200);
    // The form the launch URL prints and `EventSource` must use instead
    // (it cannot set a header at all) — `ui/src/hooks.ts`'s `/api/events`.
    const viaQuery = await fetch(`http://${h.host}:${h.port}/api/modules?token=${h.token}`);
    assert.equal(viaQuery.status, 200);
    // A wrong token is exactly as unauthorized as no token.
    const wrong = await fetch(`http://${h.host}:${h.port}/api/modules`, {
      headers: { Authorization: "Bearer not-the-token" },
    });
    assert.equal(wrong.status, 401);
  } finally {
    await h.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("--no-auth serves unauthenticated (the e2e rig's mode)", async () => {
  const outDir = buildArtifact();
  const h = await startUiServer({ projectDir: outDir, port: 0, host: "127.0.0.1", workers: false, prewarm: false, noAuth: true });
  try {
    assert.equal(h.token, undefined, "noAuth must mint no token");
    const r = await fetch(`http://${h.host}:${h.port}/api/modules`);
    assert.equal(r.status, 200);
  } finally {
    await h.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("CORS reflects only the launched origin", async () => {
  const outDir = buildArtifact();
  const h = await startUiServer({
    projectDir: outDir,
    port: 0,
    host: "127.0.0.1",
    workers: false,
    prewarm: false,
    noAuth: true,
    origin: "http://127.0.0.1:4173",
  });
  try {
    const matched = await fetch(`http://${h.host}:${h.port}/api/modules`, {
      headers: { Origin: "http://127.0.0.1:4173" },
    });
    assert.equal(matched.headers.get("access-control-allow-origin"), "http://127.0.0.1:4173");
    // A different loopback origin, which the pre-L2 loopback-any default
    // would have reflected, must now get NO CORS header at all.
    const other = await fetch(`http://${h.host}:${h.port}/api/modules`, {
      headers: { Origin: "http://127.0.0.1:9999" },
    });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
  } finally {
    await h.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});
