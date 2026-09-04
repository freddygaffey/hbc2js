// src/workers/backends/heuristic.ts — a REAL, runnable worker backend that
// needs no model at all (docs/specs/23-ui-workers.md §2.5's `WorkerBackend`
// boundary; §9 item 1 reserves the *choice* of backend to the owner, and this
// is the one choice that can ship enabled by default because it has no key,
// no network and no spawn).
//
// Why it exists: `FakeBackend` answers `fakefn188`, which is enough for a
// runner test and useless in the UI. `HeuristicBackend` answers from the
// function's OWN evidence — the property/callee names and string literals in
// its rendered source, plus the summary the runner already read — so the
// end-to-end product flow (enqueue -> running -> done -> suggestion ->
// promote/reject) is real today, and a `CliBackend`/`HttpBackend` is a
// drop-in replacement tomorrow with nothing else changing.
//
// It is DETERMINISTIC: same request in, same text out, no clock, no random,
// no I/O. That is what lets it be asserted in the gate like any pure function
// and what makes a suggestion reproducible for a human reviewing provenance.
import type { WorkerBackend, WorkerJobRequest, WorkerJobResponse } from "../backend.ts";

/** What the runner puts in `context` (see `WorkerRunner.request`). Read
 *  defensively — a backend never assumes a shape it did not itself build. */
interface HeuristicContext {
  readonly target?: unknown;
  readonly summary?: unknown;
  readonly source?: unknown;
}

interface Summaryish {
  readonly fn?: unknown;
  readonly name?: unknown;
  readonly overlayName?: unknown;
  readonly module?: unknown;
  readonly file?: unknown;
  readonly lines?: unknown;
  readonly params?: unknown;
  readonly kind?: unknown;
  readonly edgesIn?: unknown;
  readonly edgesOut?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Identifiers we never name a function after: the emitter's own helpers, the
 *  runtime globals every module touches, and JS keywords. Keeping this list
 *  short and explicit beats a frequency threshold — a bundle where every
 *  function "is" `require` is exactly the failure mode. */
const STOP = new Set([
  "require", "module", "exports", "default", "prototype", "constructor", "call", "apply", "bind",
  "then", "catch", "finally", "length", "push", "pop", "slice", "map", "filter", "forEach",
  "toString", "valueOf", "hasOwnProperty", "console", "log", "warn", "error", "Object", "Array",
  "String", "Number", "Boolean", "Promise", "Math", "JSON", "undefined", "null", "true", "false",
  "this", "function", "return", "var", "let", "const", "if", "else", "for", "while", "new", "typeof",
  "__hbc_makeGenerator", "__hbc_env", "__hbc_this", "arguments",
]);

/** Every `.foo(` / `.foo` and every bare `foo(` call in the rendered source,
 *  most-used first, ties broken by first appearance (so the answer is a total
 *  order and therefore deterministic). */
export function calleeNames(source: string): readonly string[] {
  const counts = new Map<string, { n: number; at: number }>();
  const re = /\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(|(?:^|[^.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    const id = m[1] ?? m[2];
    if (id === undefined || STOP.has(id) || id.length < 3) continue;
    const seen = counts.get(id);
    if (seen === undefined) counts.set(id, { n: 1, at: m.index });
    else seen.n += 1;
  }
  return [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[1].at - b[1].at).map(([k]) => k);
}

/** String literals in the rendered source, longest-useful first. */
export function stringLiterals(source: string): readonly string[] {
  const out: string[] = [];
  const re = /"([^"\\\n]{2,60})"|'([^'\\\n]{2,60})'/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    const s = m[1] ?? m[2];
    if (s !== undefined && !out.includes(s)) out.push(s);
  }
  return out;
}

function camel(parts: readonly string[]): string {
  const cleaned = parts
    .join(" ")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter((p) => p.length > 0);
  if (cleaned.length === 0) return "";
  const head = cleaned[0]!.toLowerCase();
  return head + cleaned.slice(1).map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase()).join("");
}

/** A name derived from the function's own evidence, never from a model:
 *  1. the most-used callee, as `<callee>Handler` (`setState` -> `setStateHandler`);
 *  2. failing that, the most promising string literal (`"user/login"` -> `userLogin`);
 *  3. failing that, the target itself (`fn:188` -> `fn188`) — always a valid
 *     identifier, never an empty suggestion. */
export function deriveName(target: string, source: string): string {
  const callee = calleeNames(source)[0];
  if (callee !== undefined) {
    const base = camel([callee]);
    if (base.length > 0) return /handler$/i.test(base) ? base : `${base}Handler`;
  }
  const lit = stringLiterals(source).find((s) => /[A-Za-z]/.test(s));
  if (lit !== undefined) {
    const base = camel([lit]).slice(0, 40);
    if (base.length > 0 && /^[A-Za-z_$]/.test(base)) return base;
  }
  return camel([target]) || "fn";
}

/** A one-paragraph STRUCTURAL description: what the function is, how many
 *  parameters it takes, what it calls, what strings it mentions. Every clause
 *  is a fact already in the project; the backend invents nothing. */
export function describe(target: string, summary: Summaryish, source: string): string {
  const bits: string[] = [];
  const name = str(summary.overlayName) ?? str(summary.name);
  const file = str(summary.file);
  const lines = Array.isArray(summary.lines) && summary.lines.length === 2 ? (summary.lines as readonly number[]) : undefined;
  const where = file !== undefined ? ` in ${file}${lines !== undefined ? `:${lines[0]}-${lines[1]}` : ""}` : "";
  const mod = num(summary.module);
  bits.push(
    `${target}${name !== undefined ? ` (${name})` : ""} is a ${str(summary.kind) ?? "function"}` +
      `${mod !== undefined ? ` in module ${mod}` : ""}${where}.`,
  );
  const params = num(summary.params);
  if (params !== undefined) bits.push(`It takes ${params} parameter${params === 1 ? "" : "s"}.`);
  const inEdges = num(summary.edgesIn);
  const outEdges = num(summary.edgesOut);
  if (inEdges !== undefined || outEdges !== undefined) {
    bits.push(`It is called from ${inEdges ?? 0} site${inEdges === 1 ? "" : "s"} and calls ${outEdges ?? 0} function${outEdges === 1 ? "" : "s"}.`);
  }
  const callees = calleeNames(source).slice(0, 5);
  if (callees.length > 0) bits.push(`Its body calls ${callees.join(", ")}.`);
  const strings = stringLiterals(source).slice(0, 4);
  if (strings.length > 0) bits.push(`It uses the strings ${strings.map((s) => JSON.stringify(s)).join(", ")}.`);
  if (callees.length === 0 && strings.length === 0) bits.push("Its body references no named callee or string literal.");
  return bits.join(" ");
}

/** The default server-owned backend: deterministic, offline, no spawn, no
 *  key. Everything it produces is still written by the RUNNER through the
 *  ordinary write tools with `tier:"suggested"` and `prov.source:"llm"` — a
 *  heuristic proposal is a proposal, and §4's "AI output never silently
 *  becomes truth" applies to it exactly as it does to a model's. */
export class HeuristicBackend implements WorkerBackend {
  readonly id = "heuristic";

  async run(req: WorkerJobRequest): Promise<WorkerJobResponse> {
    const ctx = req.context as HeuristicContext;
    const target = str(ctx.target) ?? "unknown";
    const source = str(ctx.source) ?? "";
    const summary = (typeof ctx.summary === "object" && ctx.summary !== null ? ctx.summary : {}) as Summaryish;
    const text = req.kind === "suggest-name" || req.kind === "name-module" ? deriveName(target, source) : describe(target, summary, source);
    return { text, cost: { tokensIn: 0, tokensOut: 0, usd: 0 } };
  }
}
