// src/ui-server/server.ts — docs/specs/22-ui-mvp.md §1's reserved MVP
// default: "one Node process: HTTP JSON server over `src/mcp/{resources,
// tools,leads}.ts` + static UI, localhost only" and "Auth: none (localhost
// bind)". This file is the ONLY http binding in the package (`routes.ts`
// stays transport-agnostic); it binds `127.0.0.1` by default and adds no
// auth of its own — that is the spec's own decision, not an oversight, and
// is revisited only at the "full build" (spec 19 §5.2), same row.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { McpContext } from "../mcp/context.ts";
import { handle, tailLog, type UiServerCtx } from "./routes.ts";

export interface UiServerOptions {
  readonly projectDir: string;
  readonly hbc?: string;
  readonly port?: number;
  readonly host?: string;
}

export interface UiServerHandle {
  readonly server: Server;
  /** The actual bound port — differs from the requested `port` when 0
   *  ("pick a free port") was passed, the pattern `tests/ui-server/
   *  routes.test.ts`'s SSE test uses to avoid a fixed-port collision. */
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

const DEFAULT_PORT = 7331;
const DEFAULT_HOST = "127.0.0.1";

// Vite dev server origins only (spec 22 §1's own framing: this IS the UI's
// backend, not a public API) — never a wildcard, never a non-loopback host.
const ALLOWED_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function corsHeaders(origin: string | undefined): Record<string, string> {
  if (origin === undefined || !ALLOWED_ORIGIN.test(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
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

/** `GET /api/events` — Server-Sent Events convenience wrapper over
 *  `tailLog` (spec 21 §1.3's read-the-log-after-my-cursor half; the MVP
 *  default is polling, §1, so this endpoint polls the log server-side
 *  every 500 ms and forwards new rows as one `log` event — the UI may use
 *  this OR poll `/api/log/tail` itself, both walk the same cursor). Starts
 *  from `?since=` if given, else from the log's current latest `seq` (so a
 *  fresh connection does not replay the whole history). */
function serveEvents(query: URLSearchParams, res: ServerResponse, ctx: UiServerCtx, extraHeaders: Record<string, string>): void {
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
  const timer = setInterval(() => {
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
  }, SSE_POLL_MS);
  res.on("close", () => clearInterval(timer));
}

export function startUiServer(opts: UiServerOptions): Promise<UiServerHandle> {
  const resourcesOpts = opts.hbc !== undefined ? { hbc: opts.hbc } : {};
  // docs/specs/17-mcp-harness.md §15: ONE `McpContext` owns the
  // `ArtifactService`/`ProjectService` pair `resources`/`tools` both read
  // and write through — a write is visible to the very next read with no
  // rebuild step (see `McpContext`'s own doc comment for why).
  const mcp = new McpContext(opts.projectDir, resourcesOpts);
  const ctx: UiServerCtx = {
    resources: mcp.resources,
    tools: mcp.tools,
    artifactDir: opts.projectDir,
  };
  const host = opts.host ?? DEFAULT_HOST;
  const requestedPort = opts.port ?? DEFAULT_PORT;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const cors = corsHeaders(req.headers.origin);

    const logLine = (status: number): void => {
      process.stderr.write(`${new Date().toISOString()} ${method} ${path} ${status} ${Date.now() - started}ms\n`);
    };

    if (method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      logLine(204);
      return;
    }

    if (path === "/api/events" && method === "GET") {
      serveEvents(url.searchParams, res, ctx, cors);
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
      resolvePromise({
        server,
        port,
        host,
        close: () =>
          new Promise<void>((res2, rej2) => {
            server.close((err) => (err !== undefined && err !== null ? rej2(err) : res2()));
          }),
      });
    });
  });
}
