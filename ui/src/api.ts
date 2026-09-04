// ui/src/api.ts — the fetch client for src/ui-server (spec 19 §3 Option A:
// one Node process, localhost only, JSON projection of McpResources). Every
// method returns a shape from ./contracts.ts verbatim.
//
// Until the server lands, `mockApi` (./mock.ts) answers instead — selected
// by `VITE_API_MOCK` (default "1"; set VITE_API_MOCK=0 to hit a real server).
import type {
  CallsFrom, FnContext, FnSummary, FunctionMatch, LeadsResult, LogTail,
  ModuleInfo, PackageIdResult, ResolvedFinding, SearchPage, SourceMatch,
  SourceText, WhoCalls, Bounded,
} from "./contracts.ts";
import { mockApi } from "./mock.ts";

export const API_BASE: string = import.meta.env["VITE_API_BASE"] ?? "http://127.0.0.1:7331";
export const USING_MOCK: boolean = (import.meta.env["VITE_API_MOCK"] ?? "1") !== "0";

export interface Api {
  fn(fn: number): Promise<FnSummary>;
  source(fn: number): Promise<SourceText>;
  disasm(fn: number): Promise<SourceText>;
  context(fn: number): Promise<FnContext>;
  whoCalls(fn: number): Promise<WhoCalls>;
  callsFrom(fn: number): Promise<CallsFrom>;
  module(id: number): Promise<ModuleInfo>;
  packageId(mod: number): Promise<PackageIdResult>;
  findings(): Promise<Bounded<ResolvedFinding>>;
  leads(): Promise<LeadsResult>;
  logTail(since: number): Promise<LogTail>;
  searchFunctions(query: string, cursor?: number): Promise<SearchPage<FunctionMatch>>;
  searchSource(query: string, cursor?: number): Promise<SearchPage<SourceMatch>>;
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
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new ApiError(res.status, path, await res.text().catch(() => res.statusText));
  return (await res.json()) as T;
}

/** Route table — spec 22 §3.5's routes, as implemented by src/ui-server.
 *  Keep in sync with docs/UI.md's route list; a route rename is a two-file
 *  change. `packageId` is the one route §3.5 does not (yet) publish — it
 *  404s against the real server, which is why the Package panel is
 *  documented as stubbed. */
export const httpApi: Api = {
  fn: (fn) => get(`/fn/${fn}`),
  source: (fn) => get(`/fn/${fn}/source`),
  disasm: (fn) => get(`/fn/${fn}/disasm`),
  context: (fn) => get(`/fn/${fn}/context`),
  whoCalls: (fn) => get(`/fn/${fn}/callers`),
  callsFrom: (fn) => get(`/fn/${fn}/callees`),
  module: (id) => get(`/module/${id}`),
  packageId: (mod) => get(`/package-id/${mod}`),
  findings: () => get(`/findings`),
  leads: () => get(`/leads`),
  logTail: (since) => get(`/log/tail`, { since }),
  searchFunctions: (query, cursor) => get(`/search/functions`, { q: query, cursor }),
  searchSource: (query, cursor) => get(`/search/source`, { q: query, cursor }),
};

export const api: Api = USING_MOCK ? mockApi : httpApi;
