// ui/src/api.ts — the fetch client for src/ui-server (spec 19 §3 Option A:
// one Node process, localhost only, JSON projection of McpResources). Every
// method returns a shape from ./contracts.ts verbatim.
//
// Until the server lands, `mockApi` (./mock.ts) answers instead — selected
// by `VITE_API_MOCK` (default "1"; set VITE_API_MOCK=0 to hit a real server).
import type {
  CallsFrom, FnCfg, FnContext, FnSummary, FunctionMatch, LeadsResult, LogTail,
  ModuleInfo, ModuleSource, PackageIdResult, ResolvedFinding, SearchPage, SourceMatch,
  SourceText, WhoCalls, Bounded, LocalsListing, LineMap, StringExact, StringGrep, GlobalUses,
  WhoCallsByName, ObjectTables,
} from "./contracts.ts";
import type { FunctionListPage, ModuleListPage } from "./listing/wire.ts";
import { mockApi } from "./mock.ts";

export const API_BASE: string = import.meta.env["VITE_API_BASE"] ?? "http://127.0.0.1:7331";
export const USING_MOCK: boolean = (import.meta.env["VITE_API_MOCK"] ?? "1") !== "0";

// Spec 26 L2 (docs/specs/26-ui-full-ide.md): the server mints a per-run
// bearer token and prints it in the launch URL's `?token=`. On first load
// this lifts it out of `location` into `sessionStorage` (so a reload of the
// SAME tab, which drops the query string once React Router or a manual
// address-bar edit rewrites the URL, keeps working); every later load reads
// it back from there. `--no-auth` servers mint no token, `AUTH_TOKEN` stays
// `undefined`, and every helper below degrades to sending nothing — exactly
// today's unauthenticated behaviour.
const TOKEN_STORAGE_KEY = "hbc2js.token";

// Minimal structural shapes rather than `lib.dom`'s `Window`/`Storage`: this
// file is reached by the ROOT gate's typecheck (via test imports), whose
// tsconfig has no DOM lib (`tests/support/import-meta-env.d.ts` does the
// same thing for `import.meta.env`, just for a different global). The real
// browser objects satisfy these shapes structurally, so nothing is lost at
// runtime — this is a type-only narrowing.
interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
interface MinimalWindow {
  readonly location: { readonly href: string };
  readonly sessionStorage: MinimalStorage;
}

function bootstrapToken(): string | undefined {
  const w = (globalThis as { window?: MinimalWindow }).window;
  if (w === undefined) return undefined;
  try {
    const fromUrl = new URL(w.location.href).searchParams.get("token");
    if (fromUrl !== null && fromUrl !== "") {
      w.sessionStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
      return fromUrl;
    }
    return w.sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? undefined;
  } catch {
    // Storage disabled (private mode, a test DOM with no sessionStorage) —
    // fall back to unauthenticated; the server will 401 if it needed one.
    return undefined;
  }
}

export const AUTH_TOKEN: string | undefined = bootstrapToken();

/** Spread into a plain `fetch`'s headers. Empty object when there is no
 *  token (mock mode, `--no-auth`, or storage disabled). */
export function authHeaders(): Record<string, string> {
  return AUTH_TOKEN !== undefined ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
}

/** `EventSource` cannot set headers, so `/api/events` takes the token as a
 *  query param instead (`src/ui-server/server.ts`'s `isAuthorized` accepts
 *  either). Empty string when there is no token — callers append it only
 *  when non-empty. */
export function authQueryParam(): string {
  return AUTH_TOKEN !== undefined ? `token=${encodeURIComponent(AUTH_TOKEN)}` : "";
}

/** `GET /api/object-tables`'s filter options (spec 17 §14.2) — the Tables
 *  tab's filter bar (`ui/src/panes/TablesPane.tsx`). All optional; an
 *  omitted field is left off the query string, so the server's own
 *  defaults (>=4 members, >=50% string-valued) apply. */
export interface ObjectTablesQuery {
  readonly minProps?: number;
  readonly stringRatio?: number;
  readonly key?: string;
  readonly value?: string;
  readonly module?: number;
  /** Minimum members satisfying `key`/`value` (server default 1) — guards
   *  the accidental single-hit in a giant table. A no-op with neither
   *  pattern given. */
  readonly minMatched?: number;
  readonly limit?: number;
}

export interface Api {
  fn(fn: number): Promise<FnSummary>;
  source(fn: number): Promise<SourceText>;
  disasm(fn: number): Promise<SourceText>;
  /** `GET /api/fn/:fn/linemap` — which source line came from which
   *  instruction (docs/specs/05-emitter.md §16); drives the centre pane's
   *  source<->disasm alignment. */
  lineMap(fn: number): Promise<LineMap>;
  /** `GET /api/fn/:fn/locals` — the fn's nameable registers, for the
   *  identifier -> `reg:F:R` rename join. */
  locals(fn: number): Promise<LocalsListing>;
  context(fn: number): Promise<FnContext>;
  /** `GET /api/fn/:fn/cfg` (spec 26 L9) — the function's block graph, drawn
   *  by the graph pane's `near` level. A 404 is the route DECLINING (no
   *  `--hbc`, or the analysis refused this function): the pane falls back to
   *  spec 25 §5b's card rather than drawing an empty graph. */
  cfg(fn: number): Promise<FnCfg>;
  whoCalls(fn: number): Promise<WhoCalls>;
  callsFrom(fn: number): Promise<CallsFrom>;
  /** `GET /api/xref/who-calls-by-name?fn=` — spec 17 §14.1's heuristic
   *  caller-candidate recovery, for the dominant RN dispatch idiom
   *  `who-calls`/`calls-from` return `total:0` for. Candidates, not proven
   *  callers (docs/UI.md "Xrefs"). */
  xrefWhoCallsByName(fn: number): Promise<WhoCallsByName>;
  module(id: number): Promise<ModuleInfo>;
  /** `GET /api/module/:id/source` — the whole file plus its fn ranges. */
  moduleSource(id: number): Promise<ModuleSource>;
  /** `GET /api/modules` — the whole module catalogue (server caps at 500). */
  modules(): Promise<ModuleListPage>;
  /** `GET /api/functions?cursor=&limit=` — one page of the fn catalogue,
   *  50 rows by default, up to `FUNCTIONS_PAGE_MAX` (1000,
   *  `src/ui-server/list.ts`) when `limit` is given. */
  functions(cursor?: number, limit?: number): Promise<FunctionListPage>;
  packageId(mod: number): Promise<PackageIdResult>;
  findings(): Promise<Bounded<ResolvedFinding>>;
  leads(): Promise<LeadsResult>;
  logTail(since: number): Promise<LogTail>;
  searchFunctions(query: string, cursor?: number): Promise<SearchPage<FunctionMatch>>;
  searchSource(query: string, cursor?: number): Promise<SearchPage<SourceMatch>>;
  /** `GET /api/xref/string?mode=substring|regex&key=` — the Strings window's
   *  search (spec 22 §3, docs/UI.md "Strings & globals (xref)"). */
  xrefStringSearch(mode: "substring" | "regex", pattern: string): Promise<StringGrep>;
  /** `GET /api/xref/string?mode=exact&key=<sid>` — expanding one search hit
   *  to its uses. */
  xrefStringUses(sid: number): Promise<StringExact>;
  /** `GET /api/xref/global?name=` — the Globals sub-view. */
  xrefGlobal(name: string): Promise<GlobalUses>;
  /** `GET /api/object-tables?minProps=&stringRatio=&key=&value=&module=&
   *  limit=` — the bundle-wide constant object-literal inventory (spec 17
   *  §14.2), the Tables tab's search. */
  objectTables(query: ObjectTablesQuery): Promise<ObjectTables>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, message: string) {
    super(`GET ${path} -> ${status}: ${message}`);
    this.name = "ApiError";
    this.status = status;
    this.path = path;
  }
}

async function get<T>(path: string, params: Readonly<Record<string, string | number | undefined>> = {}): Promise<T> {
  const url = new URL(`/api${path}`, API_BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { accept: "application/json", ...authHeaders() } });
  if (!res.ok) throw new ApiError(res.status, path, await res.text().catch(() => res.statusText));
  return (await res.json()) as T;
}

/** Route table — spec 22 §3.5's routes, as implemented by src/ui-server.
 *  Keep in sync with docs/UI.md's route list; a route rename is a two-file
 *  change. `packageId` (wave 4a) is published by the real server too —
 *  always 200, `{available:false, reason}` when the module has no cleared
 *  identification, never a 404. */
export const httpApi: Api = {
  fn: (fn) => get(`/fn/${fn}`),
  source: (fn) => get(`/fn/${fn}/source`),
  disasm: (fn) => get(`/fn/${fn}/disasm`),
  lineMap: (fn) => get(`/fn/${fn}/linemap`),
  locals: (fn) => get(`/fn/${fn}/locals`),
  context: (fn) => get(`/fn/${fn}/context`),
  cfg: (fn) => get(`/fn/${fn}/cfg`),
  whoCalls: (fn) => get(`/fn/${fn}/callers`),
  callsFrom: (fn) => get(`/fn/${fn}/callees`),
  xrefWhoCallsByName: (fn) => get(`/xref/who-calls-by-name`, { fn }),
  module: (id) => get(`/module/${id}`),
  moduleSource: (id) => get(`/module/${id}/source`),
  modules: () => get(`/modules`),
  functions: (cursor, limit) => get(`/functions`, { cursor, limit }),
  packageId: (mod) => get(`/package-id/${mod}`),
  findings: () => get(`/findings`),
  leads: () => get(`/leads`),
  logTail: (since) => get(`/log/tail`, { since }),
  searchFunctions: (query, cursor) => get(`/search/functions`, { q: query, cursor }),
  searchSource: (query, cursor) => get(`/search/source`, { q: query, cursor }),
  xrefStringSearch: (mode, pattern) => get(`/xref/string`, { mode, key: pattern }),
  xrefStringUses: (sid) => get(`/xref/string`, { mode: "exact", key: sid }),
  xrefGlobal: (name) => get(`/xref/global`, { name }),
  objectTables: (query) => get(`/object-tables`, { ...query }),
};

export const api: Api = USING_MOCK ? mockApi : httpApi;
