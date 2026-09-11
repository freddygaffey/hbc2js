// src/ui-server/server.ts — docs/specs/22-ui-mvp.md §1's reserved MVP
// default: "one Node process: HTTP JSON server over `src/mcp/{resources,
// tools,leads}.ts` + static UI, localhost only" and "Auth: none (localhost
// bind)". This file is the ONLY http binding in the package (`routes.ts`
// stays transport-agnostic); it binds `127.0.0.1` by default.
//
// Spec 26 L2 (docs/specs/26-ui-full-ide.md): the MVP's "no auth" default is
// revisited here. Every run now mints a per-process bearer token (unless
// `noAuth: true` — CLI `--no-auth`, used by the e2e rigs, which never leaves
// loopback and needs no token ceremony). Every `/api/*` request (including
// `/api/events`, which is handled by its own branch below) must present it
// either as `Authorization: Bearer <token>` or, since `EventSource` cannot
// set headers, `?token=<token>` on the URL — the SPA does the former for
// ordinary fetches and the latter for its one `EventSource` connection
// (`ui/src/hooks.ts`). Static asset serving (`serveStatic`) stays
// unauthenticated: the launch URL itself carries the token
// (`http://host:port/?token=...`), so the shell must be reachable before it
// has anywhere to read the token from; the shell then lifts it into
// `sessionStorage` (`ui/src/api.ts`) and only THEN starts calling `/api/*`.
// `origin` (CLI `--origin`), when given, replaces the loopback-any CORS
// check below with an exact match against that one origin — the default
// (no `--origin`) keeps the prior loopback-any behaviour because the
// launcher does not know, in general, which port a separately-served SPA
// (`vite dev`/`vite preview`) will use.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { McpContext } from "../mcp/context.ts";
import { openProjectDb } from "../projdb/db.ts";
import { dbPath } from "../projdb/artifact-read.ts";
import { JobQueue } from "../workers/queue.ts";
import { Presence } from "../workers/presence.ts";
import { WorkerRunner } from "../workers/runner.ts";
import { HeuristicBackend } from "../workers/backends/heuristic.ts";
import type { WorkerBackend, WorkerJobRequest, WorkerJobResponse } from "../workers/backend.ts";
import { backendForId, resolveBackendId } from "../readability/backends.ts";
import { SKILL_FOR_KIND } from "../readability/types.ts";
import type { ReadabilityContext } from "../readability/surfaces.ts";
import { handle, tailLog, WRITE_TOOL_PATHS, type UiServerCtx } from "./routes.ts";
import { hasReadableTree, type ReadabilityRoutesCtx } from "./readability-routes.ts";
import { segregation } from "./segregation.ts";
import { tailWorkerEvents, type WorkersCtx } from "./workers-routes.ts";

export interface UiServerOptions {
  readonly projectDir: string;
  readonly hbc?: string;
  readonly port?: number;
  readonly host?: string;
  /** Spec 23's server-owned worker pool. Default ON: the shipped backend is
   *  `HeuristicBackend` — deterministic, offline, no key, no spawn — so
   *  "enabled by default" costs nothing and the AI flow in the UI is real
   *  rather than stubbed (spec 23 §9 item 1 reserves the backend choice to
   *  the owner; this is that choice for the default). `--workers off` (CLI)
   *  or `workers: false` turns the pool off; the routes then 503. */
  readonly workers?: boolean;
  /** Jobs in flight (spec 23 §2.2's cap; the UI shows it). */
  readonly workerConcurrency?: number;
  /** Default ON: right after `listen`, warm the whole-bundle live-frame
   *  analysis (`ArtifactService.warmFrames`) off the request path — on a
   *  large bundle (measured 65 s on Service NSW's 4,510 modules) this is the
   *  computation the first `/api/fn/{fn}/locals` or `/api/module/{id}/source`
   *  would otherwise pay for synchronously, freezing every other route
   *  meanwhile (docs/UI.md "Cold start"). `false` (CLI `--no-prewarm`) skips
   *  it — the tests use this so a fixture's tiny bundle does not warm work
   *  it never asks for. No-op either way when `hbc` is not given. */
  readonly prewarm?: boolean;
  /** Spec 26 L2: disables both the per-run bearer token AND the CORS
   *  narrowing below (CLI `--no-auth`) — the e2e rigs' mode, since they
   *  never leave loopback and mint their own throwaway project per run. */
  readonly noAuth?: boolean;
  /** Spec 26 L2: when given (CLI `--origin <url>`), CORS reflects ONLY this
   *  exact origin instead of the loopback-any default. */
  readonly origin?: string;
  /** Spec 28 landing 4d: the readability surface's OWN backend choice (CLI
   *  `--llm-backend <id>`), independent of the spec-23 worker pool's
   *  `buildUiBackend` routing above -- a caller may want e.g. `fake` for the
   *  readability routes in a test rig while the ordinary job pool still runs
   *  `heuristic`. Falls back to `HBC2JS_LLM_BACKEND`/the default
   *  (`resolveBackendId`'s own rule) when omitted. */
  readonly llmBackend?: string;
}

export interface UiServerHandle {
  readonly server: Server;
  /** The actual bound port — differs from the requested `port` when 0
   *  ("pick a free port") was passed, the pattern `tests/ui-server/
   *  routes.test.ts`'s SSE test uses to avoid a fixed-port collision. */
  readonly port: number;
  readonly host: string;
  /** The ctx every route runs against. Exposed so a caller (and the tests)
   *  can inspect server-lifetime state such as the segregation cache. */
  readonly ctx: UiServerCtx;
  /** The minted per-run bearer token, or `undefined` under `noAuth: true`.
   *  The CLI (`src/cli.ts`) prints this in the launch URL's `?token=`. */
  readonly token?: string;
  close(): Promise<void>;
}

// Spec 26 L2: kernel-assigned by default (CLI `--port` pins it); every
// existing caller of `startUiServer` already passes `port: 0` explicitly
// (tests) or `--port` (the real rigs), so this default only ever bites a
// caller that asks for neither.
const DEFAULT_PORT = 0;
const DEFAULT_HOST = "127.0.0.1";

// Vite dev server origins only (spec 22 §1's own framing: this IS the UI's
// backend, not a public API) — never a wildcard, never a non-loopback host.
// This is the default; `opts.origin` (spec 26 L2) replaces it with an exact
// match when given.
const ALLOWED_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function corsHeaders(origin: string | undefined, allowedOrigin: string | undefined): Record<string, string> {
  if (origin === undefined) return {};
  const ok = allowedOrigin !== undefined ? origin === allowedOrigin : ALLOWED_ORIGIN.test(origin);
  if (!ok) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

/** Spec 26 L2: a request without the right token is a 401, unless the
 *  server was started with `noAuth: true`. Accepted two ways: the ordinary
 *  `Authorization: Bearer <token>` header (every plain `fetch`), or
 *  `?token=<token>` on the URL (the one path a browser's native
 *  `EventSource` can use, since it cannot set headers at all). */
function isAuthorized(req: IncomingMessage, url: URL, token: string | undefined): boolean {
  if (token === undefined) return true;
  const header = req.headers.authorization;
  if (header === `Bearer ${token}`) return true;
  return url.searchParams.get("token") === token;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolvePromise(undefined);
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        rejectPromise(new Error(`invalid JSON body: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
    req.on("error", rejectPromise);
  });
}

const UI_DIST = fileURLToPath(new URL("../../ui/dist", import.meta.url));

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Serves `ui/dist/` if it has been built; otherwise every non-`/api` path
 *  answers a JSON 404 (spec's own requirement: "404/400/500 JSON errors
 *  with a `reason`" — even the "UI not built yet" case). SPA fallback to
 *  `index.html` for any path with no file extension (client-side routing),
 *  same convention Vite's own `preview` server uses. */
function serveStatic(path: string, res: ServerResponse, extraHeaders: Record<string, string>): void {
  if (!existsSync(UI_DIST)) {
    res.writeHead(404, { "Content-Type": "application/json", ...extraHeaders });
    res.end(JSON.stringify({ reason: "ui not built" }));
    return;
  }
  const rel = path === "/" ? "/index.html" : path;
  let filePath = normalize(join(UI_DIST, rel));
  if (!filePath.startsWith(UI_DIST)) {
    res.writeHead(400, { "Content-Type": "application/json", ...extraHeaders });
    res.end(JSON.stringify({ reason: "bad path" }));
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) filePath = join(UI_DIST, "index.html");
  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "application/json", ...extraHeaders });
    res.end(JSON.stringify({ reason: "ui not built" }));
    return;
  }
  const ext = extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream", ...extraHeaders });
  res.end(readFileSync(filePath));
}

const SSE_POLL_MS = 500;

/** How often the pool looks for a claimable job. Short enough that a button
 *  press in the UI feels immediate, long enough to be free when idle (one
 *  indexed SELECT). */
const WORKER_POLL_MS = 250;
const DEFAULT_WORKER_CONCURRENCY = 2;

interface WorkerPool {
  readonly ctx: WorkersCtx;
  stop(): void;
}

/** Job kinds a skill is routed for (spec 28's `SKILL_FOR_KIND`) — everything
 *  else (e.g. spec 23's non-LLM kinds) keeps using `HeuristicBackend`, which
 *  needs no key, no binary and no spawn. */
const LLM_JOB_KINDS: ReadonlySet<string> = new Set(Object.keys(SKILL_FOR_KIND));

/** Sends LLM-shaped jobs to `llm`, everything else to `fallback` — the UI
 *  pool has exactly one `WorkerBackend`, so this is how spec 28 section 9.1's
 *  default (`claude-cli`, opt-in `haiku`) coexists with the zero-config
 *  heuristic backend that has always driven non-LLM job kinds. */
class RoutedWorkerBackend implements WorkerBackend {
  readonly id: string;
  private readonly llm: WorkerBackend;
  private readonly fallback: WorkerBackend;
  constructor(llm: WorkerBackend, fallback: WorkerBackend) {
    this.llm = llm;
    this.fallback = fallback;
    this.id = `${llm.id}+${fallback.id}`;
  }
  run(req: WorkerJobRequest, signal?: AbortSignal): Promise<WorkerJobResponse> {
    return (LLM_JOB_KINDS.has(req.kind) ? this.llm : this.fallback).run(req, signal);
  }
}

/** Fred's ruling (2026-09-11, verbatim): "It should run on the Claude plan on
 *  the shell ... they should not be using the API because API is more
 *  expensive." `claude-cli` is therefore the UI pool's default for LLM-kind
 *  jobs (`HBC2JS_LLM_BACKEND=haiku` opts into the metered API); a bad env
 *  value falls back to the heuristic-only pool rather than crashing the
 *  server (this function is called from a "never throws" context). */
function buildUiBackend(env: Readonly<Record<string, string | undefined>>): WorkerBackend {
  const fallback = new HeuristicBackend();
  try {
    const llmId = resolveBackendId(undefined, env);
    if (llmId === "heuristic" || llmId === "fake") return fallback;
    const llm = backendForId(llmId, { env });
    return new RoutedWorkerBackend(llm, fallback);
  } catch {
    return fallback;
  }
}

/** Builds the spec-23 worker surface over an ALREADY-OPEN project DB (shared
 *  with `buildReadabilityCtx` below — spec 28 landing 4d wires both surfaces
 *  off the SAME connection, the way `McpContext` already shares one
 *  `ArtifactService`/`ProjectService` pair) and starts ONE pool loop over
 *  `buildUiBackend`'s choice (spec 28 section 9.1's default, `claude-cli`,
 *  routed only to LLM-kind jobs; `HeuristicBackend` otherwise). Never closes
 *  `db` — the caller (`startUiServer`) owns that, since the readability ctx
 *  may still be using the same connection after `pool.stop()` runs. Never
 *  throws: a server that can serve source must still start. */
function startWorkers(db: DatabaseSync, mcp: McpContext, concurrency: number): WorkerPool {
  const queue = new JobQueue(db);
  const presence = new Presence(db);
  const backend = buildUiBackend(process.env);
  const session = presence.open({ kind: "worker", who: `worker:${backend.id}`, meta: { pool: concurrency } });
  const runner = new WorkerRunner({
    db,
    resources: mcp.resources,
    tools: mcp.tools,
    backend,
    queue,
    presence,
    sessionId: session.id,
    // spec 23 §4 + spec 17 §15's `tier`: a proposal lands as a
    // `tier:"suggested"` name (promotable by rid) as well as a comment. It is
    // still never truth — promotion is.
    writeSuggestedNames: true,
  });
  let busy = false;
  const timer = setInterval(() => {
    presence.heartbeat(session.id);
    presence.expire();
    if (busy) return;
    busy = true;
    void runner
      .runUntilIdle({ concurrency })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, WORKER_POLL_MS);
  timer.unref?.();
  return {
    ctx: { db, queue, presence, runner, backendId: backend.id, concurrency },
    stop: () => {
      clearInterval(timer);
      try {
        presence.close(session.id, "server stopped");
      } catch {
        /* closing presence on a DB the process is about to drop is never fatal */
      }
    },
  };
}

/** Spec 28 landing 4d: builds the `ReadabilityRoutesCtx` `readability-
 *  routes.ts` needs off the SAME already-open project DB the worker pool
 *  uses (`db`, shared — see `startWorkers`'s own doc comment), the split
 *  tree `init`/`--split` always write at `<projectDir>/src` (`src/cli.ts`'s
 *  `runInit`), and `opts.hbc` as the equivalence oracle's ground truth.
 *  Returns undefined (routes 503, same "absent, not faked" convention as
 *  `WorkersCtx`) when: there is no db, no readable tree at `<projectDir>/
 *  src`, or the configured backend id is invalid — a bad `--llm-backend`
 *  disables readability rather than silently downgrading it to a different
 *  subsystem's fallback (`buildUiBackend`'s own fallback is a DIFFERENT
 *  pool, spec 23's, not this one). Never throws. */
function buildReadabilityCtx(db: DatabaseSync | undefined, projectDir: string, opts: UiServerOptions): ReadabilityRoutesCtx | undefined {
  if (db === undefined) return undefined;
  const treeDir = join(projectDir, "src");
  if (!hasReadableTree(treeDir)) return undefined;
  let backend: WorkerBackend;
  try {
    const id = resolveBackendId(opts.llmBackend, process.env);
    backend = backendForId(id, { env: process.env, projectDir });
  } catch {
    return undefined;
  }
  const context: ReadabilityContext = {
    db,
    projectDir,
    treeDir,
    backend,
    surface: "ui",
    ...(opts.hbc !== undefined ? { hbcPath: opts.hbc } : {}),
  };
  return { context, backendId: backend.id };
}

/** Spec 21 §1.3's in-process doorbell: `server.ts`'s request handler
 *  `emit`s `"wrote"` right after a write route lands (below, `WRITE_TOOL_
 *  PATHS`); every open `/api/events` connection's `checkNow` (in
 *  `serveEvents`) listens and re-checks the log immediately instead of
 *  waiting for the next `SSE_POLL_MS` tick. One emitter per server
 *  instance (`startUiServer` owns it) — this is a zero-latency hint, never
 *  the source of truth: the log (`tailLog`) stays authoritative, so a
 *  connection that started before a given `wrote()` (or a second process
 *  with no access to this in-process emitter at all) still converges via
 *  the poll fallback with no special-casing, per spec 21 §1.3. */
type WriteBus = EventEmitter;

function newWriteBus(): WriteBus {
  const bus = new EventEmitter();
  // Many SSE connections (many tabs) all listen to the same write; the
  // default cap of 10 is a real ceiling a busy multi-tab session can hit.
  bus.setMaxListeners(0);
  return bus;
}

/** `GET /api/events` — Server-Sent Events convenience wrapper over
 *  `tailLog` (spec 21 §1.3's read-the-log-after-my-cursor half; the MVP
 *  default is polling, §1, so this endpoint polls the log server-side
 *  every 500 ms and forwards new rows as one `log` event — the UI may use
 *  this OR poll `/api/log/tail` itself, both walk the same cursor). Starts
 *  from `?since=` if given, else from the log's current latest `seq` (so a
 *  fresh connection does not replay the whole history). The `bus`'s
 *  `"wrote"` event (above) triggers the SAME check function immediately,
 *  so a write is forwarded within one event loop turn rather than waiting
 *  up to `SSE_POLL_MS` — the interval stays running underneath as the
 *  fallback for a missed/coalesced doorbell (spec 21 §1.3) and as the only
 *  path when nothing ever emits (a second process writing the same log). */
function serveEvents(query: URLSearchParams, res: ServerResponse, ctx: UiServerCtx, extraHeaders: Record<string, string>, bus: WriteBus): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...extraHeaders,
  });
  res.write(":connected\n\n");
  const sinceParam = query.get("since");
  // `tailLog` runs a fresh `log` query every call — `ctx.resources` is the
  // one long-lived `McpContext`-shared instance (no rebuild anywhere, §15),
  // so a concurrent write is visible on the very next poll regardless.
  let cursor = sinceParam !== null && sinceParam !== "" ? Number(sinceParam) : tailLog(ctx.resources, 0).cursor;
  // Second channel on the SAME connection (spec 23 §4.1's `worker_events`
  // change feed): one `event: worker` frame with the same {rows,cursor}
  // shape, its own cursor, from `?workerSince=` or the current head. Two
  // feeds, one socket — a client that only cares about the log ignores the
  // frame, and nothing about the log channel changes.
  const workerSinceParam = query.get("workerSince");
  let workerCursor =
    workerSinceParam !== null && workerSinceParam !== ""
      ? Number(workerSinceParam)
      : ctx.workers !== undefined
        ? tailWorkerEvents(ctx.workers.db, 0).cursor
        : 0;
  const check = (): void => {
    let result;
    try {
      result = tailLog(ctx.resources, cursor);
    } catch {
      return; // project dir has no log (JSONL-backed) — just stay quiet
    }
    if (result.rows.length > 0) {
      cursor = result.cursor;
      res.write(`event: log\ndata: ${JSON.stringify(result)}\n\n`);
    }
    if (ctx.workers !== undefined) {
      try {
        const w = tailWorkerEvents(ctx.workers.db, workerCursor);
        if (w.rows.length > 0) {
          workerCursor = w.cursor;
          res.write(`event: worker\ndata: ${JSON.stringify(w)}\n\n`);
        }
      } catch {
        /* the worker tables are disposable state; a read failure is not fatal */
      }
    }
  };
  const timer = setInterval(check, SSE_POLL_MS);
  // The doorbell: same `check`, fired the moment a write lands rather than
  // on the next tick (spec 21 §1.3). `bus` outlives no connection — always
  // remove the listener on close, or every reconnect leaks one.
  bus.on("wrote", check);
  res.on("close", () => {
    clearInterval(timer);
    bus.off("wrote", check);
  });
}

export function startUiServer(opts: UiServerOptions): Promise<UiServerHandle> {
  const resourcesOpts = opts.hbc !== undefined ? { hbc: opts.hbc } : {};
  // docs/specs/17-mcp-harness.md §15: ONE `McpContext` owns the
  // `ArtifactService`/`ProjectService` pair `resources`/`tools` both read
  // and write through — a write is visible to the very next read with no
  // rebuild step (see `McpContext`'s own doc comment for why).
  const mcp = new McpContext(opts.projectDir, resourcesOpts);
  // ONE project-db connection, shared by the spec-23 worker pool and the
  // spec-28 readability routes below (both `startWorkers` and
  // `buildReadabilityCtx`'s own doc comments) — undefined for a JSONL-only
  // project (no `.hbcproj`), same "absent, not faked" convention as before.
  const dbFilePath = dbPath(opts.projectDir);
  let sharedDb: DatabaseSync | undefined;
  if (existsSync(dbFilePath)) {
    try {
      sharedDb = openProjectDb(dbFilePath);
    } catch {
      sharedDb = undefined;
    }
  }
  const pool =
    sharedDb !== undefined && opts.workers !== false
      ? startWorkers(sharedDb, mcp, Math.max(1, opts.workerConcurrency ?? DEFAULT_WORKER_CONCURRENCY))
      : undefined;
  const readability = buildReadabilityCtx(sharedDb, opts.projectDir, opts);
  const ctx: UiServerCtx = {
    resources: mcp.resources,
    tools: mcp.tools,
    artifactDir: opts.projectDir,
    ...(pool !== undefined ? { workers: pool.ctx } : {}),
    ...(readability !== undefined ? { readability } : {}),
  };
  const host = opts.host ?? DEFAULT_HOST;
  const requestedPort = opts.port ?? DEFAULT_PORT;
  // Spec 21 §1.3's zero-latency doorbell (see `serveEvents`'s doc comment
  // above) — one bus per server instance, emitted right after a write
  // route lands below.
  const writeBus = newWriteBus();
  // Spec 26 L2: minted once per process, `undefined` under `noAuth: true`.
  const token = opts.noAuth === true ? undefined : randomBytes(24).toString("hex");

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const cors = corsHeaders(req.headers.origin, opts.origin);

    const logLine = (status: number): void => {
      process.stderr.write(`${new Date().toISOString()} ${method} ${path} ${status} ${Date.now() - started}ms\n`);
    };

    if (method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      logLine(204);
      return;
    }

    // Spec 26 L2: every `/api/*` route — including `/api/events`, handled
    // by its own branch just below — requires the token first. A rejected
    // request never reaches `handle()`/`serveEvents` at all.
    if (path.startsWith("/api/") && !isAuthorized(req, url, token)) {
      res.writeHead(401, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ reason: "unauthorized" }));
      logLine(401);
      return;
    }

    if (path === "/api/events" && method === "GET") {
      serveEvents(url.searchParams, res, ctx, cors, writeBus);
      logLine(200);
      return;
    }

    if (!path.startsWith("/api/")) {
      if (method !== "GET") {
        res.writeHead(404, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ reason: "not found" }));
        logLine(404);
        return;
      }
      serveStatic(path, res, cors);
      logLine(200);
      return;
    }

    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;

    (method === "GET" ? Promise.resolve(undefined) : readBody(req))
      .then((body) => handle({ method, path, query, body }, ctx))
      .then((result) => {
        res.writeHead(result.status, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify(result.json));
        logLine(result.status);
        // Spec 26 L1 (i): "after any write that lands, and after the log
        // gains rows, emit wrote(seq, targets)". `WRITE_TOOL_PATHS` is
        // already the routes layer's own "which routes mint a log row"
        // classification (`routes.ts`'s own doc comment on it) — reused
        // here rather than re-deriving it. `result.status === 200` so a
        // REJECTED write (400/404/500 — nothing landed) never rings the
        // doorbell for nothing.
        if (result.status === 200 && WRITE_TOOL_PATHS.has(path)) writeBus.emit("wrote");
      })
      .catch((e: unknown) => {
        res.writeHead(500, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ reason: e instanceof Error ? e.message : String(e) }));
        logLine(500);
      });
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(requestedPort, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : requestedPort;
      // Segregating a 4,510-module bundle took 70 s on a loaded box, and
      // the left pane's tree cannot group itself until it lands. Warm it
      // here, off the first request's critical path, so by the time a
      // browser asks the answer is already a map lookup. Failures are
      // swallowed on purpose: `segregation()` caches `null` for a project
      // with no module files, and the tree falls back on its own.
      setImmediate(() => {
        try {
          segregation(ctx);
        } catch {
          /* a project we cannot segregate is one the UI falls back for */
        }
      });
      // Cold-start prewarm (docs/UI.md "Cold start"): schedule the
      // whole-bundle live-frame analysis now, before any browser has asked
      // for it, so a `/locals`/`/source` request lands on already-computed
      // frames instead of triggering (and blocking every other route behind)
      // a from-scratch pass. `warmFrames` itself no-ops without `--hbc` and
      // shares its in-flight computation with any request that beats it
      // there, so this is safe to always attempt when `prewarm` is not
      // explicitly disabled.
      if (opts.prewarm !== false && opts.hbc !== undefined) {
        const warmStarted = Date.now();
        process.stderr.write(`${new Date().toISOString()} ui-server: warming analysis (whole-bundle live frames) …\n`);
        mcp.artifact.warmFrames().then(
          () => process.stderr.write(`${new Date().toISOString()} ui-server: warming analysis … done in ${Date.now() - warmStarted}ms\n`),
          (e: unknown) =>
            process.stderr.write(
              `${new Date().toISOString()} ui-server: warming analysis failed: ${e instanceof Error ? e.message : String(e)}\n`,
            ),
        );
      }
      resolvePromise({
        server,
        port,
        host,
        ctx,
        ...(token !== undefined ? { token } : {}),
        close: () =>
          new Promise<void>((res2, rej2) => {
            pool?.stop();
            try {
              sharedDb?.close();
            } catch {
              /* closing a DB the process is about to drop is never fatal */
            }
            server.close((err) => (err !== undefined && err !== null ? rej2(err) : res2()));
          }),
      });
    });
  });
}
