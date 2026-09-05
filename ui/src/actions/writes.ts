// ui/src/actions/writes.ts — the write half of the API client. Reads go
// through ui/src/api.ts + hooks.ts (TanStack Query); writes are one-shot
// POSTs to `/api/tools/*`, which are exactly `McpTools`' methods (spec 22
// §3.1: "rename and comment call the same McpTools.setName / addComment as
// MCP clients, so they are logged, exported and hash-locked identically").
//
// The server answers `{ rid, line }` on success and `{ reason }` with a 4xx
// on refusal (e.g. a finding whose evidence does not resolve, spec 17 §14).
// `ToolError.reason` is that string VERBATIM — never reworded, because the
// server's refusal is the only thing that tells the user what to fix.
import { API_BASE, USING_MOCK, authHeaders } from "../api.ts";
import type { EvidenceRef, FindingStatus, Provenance, Severity, Tag } from "../contracts.ts";

/** `McpTools.ToolResult`: the record id plus a one-line confirmation. */
export interface ToolResult {
  readonly rid: string;
  readonly line: string;
}

export class ToolError extends Error {
  readonly reason: string;
  readonly status: number;
  constructor(status: number, reason: string) {
    super(reason);
    this.name = "ToolError";
    this.reason = reason;
    this.status = status;
  }
}

/** Every write carries provenance; the UI writes as a human named "ui". */
export const UI_PROV: Provenance = { source: "human", who: "ui" };

/** Annotation targets are STRINGS (`fn:7992`, `mod:1086`), not objects. */
export function fnTarget(fn: number): string {
  return `fn:${fn}`;
}

async function post(path: string, body: unknown): Promise<ToolResult> {
  if (USING_MOCK) {
    throw new ToolError(0, "the shell is in mock mode — start src/ui-server and run the dev server with VITE_API_MOCK=0 to write");
  }
  const res = await fetch(new URL(`/api/tools/${path}`, API_BASE), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? {} : JSON.parse(text);
  } catch {
    parsed = { reason: text };
  }
  if (!res.ok) {
    const reason = typeof (parsed as { reason?: unknown }).reason === "string" ? (parsed as { reason: string }).reason : text;
    throw new ToolError(res.status, reason === "" ? res.statusText : reason);
  }
  return parsed as ToolResult;
}

export const setName = (target: string, name: string): Promise<ToolResult> =>
  post("set-name", { target, name, prov: UI_PROV });

export const addComment = (target: string, body: string): Promise<ToolResult> =>
  post("add-comment", { target, body, prov: UI_PROV });

export const addTag = (target: string, tag: Tag, note?: string): Promise<ToolResult> =>
  post("add-tag", { target, tag, prov: UI_PROV, ...(note !== undefined ? { note } : {}) });

export interface RecordFindingBody {
  readonly class: Severity;
  readonly location: { readonly fn: number };
  readonly claim: string;
  readonly evidence: readonly EvidenceRef[];
  readonly cwe?: string;
}

export const recordFinding = (body: RecordFindingBody): Promise<ToolResult> =>
  post("record-finding", { ...body, prov: UI_PROV });

/** Spec 26 L6: `POST /api/tools/set-finding-status`. A rejected transition
 *  (evidence gate, spec 19 §1.4) throws `ToolError` whose `.reason` is the
 *  backend's own message verbatim — callers must show it as-is, never
 *  reworded. */
export const setFindingStatus = (findingRid: string, to: FindingStatus, evidence: readonly EvidenceRef[]): Promise<ToolResult> =>
  post("set-finding-status", { findingRid, to, evidence, prov: UI_PROV });
