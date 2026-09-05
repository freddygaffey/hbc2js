// src/ui-server/native.ts — `GET /api/native/{modules,module/:x,seams,
// manifest}`, docs/specs/27-native-side.md §L5.
//
// A THIN wrapper over `McpResources`'s own §L5 verbs (`nativeModules`,
// `nativeModule`, `seams`, `nativeManifest`) — same idiom as `cfg.ts`/
// `screens.ts`: this file never re-derives a native fact, it only shapes the
// HTTP surface. `native/` is optional-by-construction (spec 27 §1.4), so a
// project with no APK ingested answers an empty list / `404` rather than a
// 500 — "no native side" is a fact, not an error.
//
// Staleness: `ctx.resources` wraps one `ArtifactService` built once per
// server process; a stale artifact (spec 10 §4.2) fails AT THAT
// CONSTRUCTION, before any route runs, so every route here inherits the
// same `E_STALE_INDEX` refusal every other `/api/*` route gets (`routes.ts`'
// `handle()` turns any `Hbc2jsError` thrown out of a handler into a 400) —
// no extra check needed here.
import type { UiRequest, UiResponse, UiServerCtx } from "./routes.ts";

interface Route {
  readonly method: "GET" | "POST";
  readonly re: RegExp;
  readonly handler: (params: readonly string[], req: UiRequest, ctx: UiServerCtx) => UiResponse | Promise<UiResponse>;
}

function qBool(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

export const NATIVE_ROUTES: readonly Route[] = [
  {
    method: "GET",
    re: /^\/api\/native\/modules$/,
    handler: (_p, req, ctx) => ({ status: 200, json: ctx.resources.nativeModules({ all: qBool(req.query.all) }) }),
  },
  {
    method: "GET",
    re: /^\/api\/native\/module\/([^/]+)$/,
    handler: ([raw], _req, ctx) => {
      const x = decodeURIComponent(raw ?? "");
      const r = ctx.resources.nativeModule(x);
      if (r === null) return { status: 404, json: { reason: `native/module/${x}: no such native module in this artifact` } };
      return { status: 200, json: r };
    },
  },
  {
    method: "GET",
    re: /^\/api\/native\/seams$/,
    handler: (_p, req, ctx) => {
      const status = req.query.status;
      const valid = status === "linked" || status === "js-only" || status === "native-only";
      if (status !== undefined && !valid) return { status: 400, json: { reason: `native/seams: bad --status ${status}` } };
      const firstParty = req.query["first-party"] !== undefined ? qBool(req.query["first-party"]) : undefined;
      return {
        status: 200,
        json: ctx.resources.seams({
          ...(valid ? { status: status as "linked" | "js-only" | "native-only" } : {}),
          ...(firstParty !== undefined ? { firstParty } : {}),
          all: qBool(req.query.all),
        }),
      };
    },
  },
  {
    method: "GET",
    re: /^\/api\/native\/manifest$/,
    handler: (_p, _req, ctx) => {
      const r = ctx.resources.nativeManifest();
      if (r === null) return { status: 404, json: { reason: "native/manifest: no native side ingested into this artifact" } };
      return { status: 200, json: r };
    },
  },
  // Not one of spec 27 §L5's four named routes, but the Context pane's own
  // native-impl row (§L5 "UI: ... a native impl row on any fn:N that
  // participates in a seam") needs a fn-bounded answer -- fetching the
  // whole `/api/native/seams` and filtering client-side would silently miss
  // a seam past `CAPS.seams`'s 100-row cap. `nativeImplFor` is already the
  // exact bounded-by-fn projection `ArtifactService`/`McpResources` expose
  // for this (spec 17's "cheap in one call" framing); this route is its one
  // HTTP wrapper, same idiom as every other route in this file.
  {
    method: "GET",
    re: /^\/api\/native\/impl\/([^/]+)$/,
    handler: ([raw], _req, ctx) => {
      const fn = Number(raw);
      if (!Number.isInteger(fn)) return { status: 400, json: { reason: `native/impl/${raw}: not a function index` } };
      if (!ctx.resources.artifact.hasFn(fn)) return { status: 404, json: { reason: `native/impl/${fn}: no such function in this artifact` } };
      return { status: 200, json: { fn, rows: ctx.resources.nativeImplFor(fn) } };
    },
  },
];
