// src/artifact/schema.ts — P2.1 artifact format: row types, schema headers,
// hashing. docs/specs/10-artifact-format.md §1–§2.
//
// This file only defines shapes + small pure helpers (hashing, header
// construction, JSONL serialisation). It never reads the bundle or the AST —
// that is `src/artifact/build.ts`'s job (spec §8 step 1 vs step 2).
import { createHash } from "node:crypto";

/** §1.2 manifest schema id. */
export const ARTIFACT_SCHEMA = "hbc2js-artifact/1";
/** §1.1 index-file schema id (every `index/*.jsonl`/`.json` file's header). */
export const INDEX_SCHEMA = "hbc2js-index/1";

export type IndexKind = "functions" | "calls" | "calls-resolved" | "strings" | "string-uses" | "globals" | "native" | "modules" | "ranges";

/** §1.1: every index file's first line. */
export interface IndexHeader {
  readonly schema: typeof INDEX_SCHEMA;
  readonly kind: IndexKind;
  readonly renderIndependent: boolean;
}

/** §2.7: `ranges.jsonl`'s header additionally carries the render hash it was
 *  built against — the thing `E_STALE_RANGES` (§4.2) compares. */
export interface RangesHeader extends IndexHeader {
  readonly kind: "ranges";
  readonly renderIndependent: false;
  readonly renderHash: string;
}

export function indexHeader(kind: Exclude<IndexKind, "ranges">): IndexHeader {
  return { schema: INDEX_SCHEMA, kind, renderIndependent: true };
}

export function rangesHeader(renderHash: string): RangesHeader {
  return { schema: INDEX_SCHEMA, kind: "ranges", renderIndependent: false, renderHash };
}

// ---- §2.1 functions.jsonl --------------------------------------------------
export interface FunctionRow {
  readonly fn: number;
  readonly name: string | null;
  readonly params: number;
  readonly module: number | null;
  readonly parent: number | null;
  readonly kind: "normal" | "generator" | "async";
  readonly offset: number;
  readonly size: number;
}

// ---- §2.2 calls.jsonl -------------------------------------------------------
/** A resolved callee is an integer `fnIndex`; otherwise one of the tagged
 *  string forms, or `"?"` (a first-class answer, never a guess — §2.2). */
export type CalleeRef = number | string;

export interface CallRow {
  readonly caller: number;
  readonly site: number;
  readonly callee: CalleeRef;
  readonly kind: "closure" | "method" | "construct" | "global" | "require" | "builtin" | "unknown";
  readonly via?: string;
  /** Mandatory when `callee === "?"` (A1b); absent otherwise. */
  readonly why?: string;
}

// ---- §2.2a calls-resolved.jsonl --------------------------------------------
/** One call edge recovered by the `require(N)` points-to pass
 *  (`src/artifact/points-to.ts`, docs/specs/17-mcp-harness.md §14.4): a call
 *  whose callee `calls.jsonl` records as `"?"` (`why: "computed-callee"`)
 *  because the receiver is a `require(dependencyMap[N])` value held in a
 *  register or an environment slot. Every field is PROVEN — the pass refuses
 *  rather than guesses (§14.4 "sound refusal") — and `confidence` marks the
 *  provenance so a consumer can never mistake it for a direct `calls.jsonl`
 *  edge. Separate file, never a rewrite of `calls.jsonl`: an old reader of
 *  the calls index keeps reading exactly what it always did. */
export interface ResolvedCallRow {
  readonly caller: number;
  /** Function-relative OFFSET (pc) of the call instruction — unlike
   *  `CallRow.site`, which is an ordinal within the caller. */
  readonly site: number;
  /** The resolved callee function index. */
  readonly callee: number;
  /** The module whose export the callee is. */
  readonly module: number;
  /** The export name the call went through. */
  readonly name: string;
  readonly confidence: "points-to";
}

// ---- §2.3 strings.json / string-uses.jsonl ---------------------------------
export interface StringEntry {
  readonly sid: number;
  readonly v: string;
}
/** §2.3a: entries over 4 KB store a head + hash instead of silently truncating. */
export interface StringEntryTruncated {
  readonly sid: number;
  readonly len: number;
  readonly sha256: string;
  readonly head: string;
}
export type StringRow = StringEntry | StringEntryTruncated;

/** §1.1: `strings.json` is a small whole-graph plain-JSON file (not JSONL —
 *  verified against `tests/artifact/sample-artifact/index/strings.json`,
 *  the A1-materialised ground truth for the shape). */
export interface StringsIndex {
  readonly schema: typeof INDEX_SCHEMA;
  readonly kind: "strings";
  readonly renderIndependent: true;
  readonly entries: readonly StringRow[];
}

export type StringUseRole = "literal" | "property-get" | "property-put" | "property-key" | "global-name" | "regexp" | "call-arg-literal";

export interface StringUseRow {
  readonly sid: number;
  readonly fn: number;
  readonly role: StringUseRole;
  readonly n: number;
}

// ---- §2.4 globals.jsonl -----------------------------------------------------
export interface GlobalRow {
  readonly g: string;
  readonly fn: number;
  readonly access: "read" | "write" | "call";
  readonly n: number;
}

// ---- §2.5 native.jsonl ------------------------------------------------------
export type NativeSurface = "builtin" | "host-global" | "host-global?" | "bridge-module";
export interface NativeRow {
  readonly fn: number;
  readonly surface: NativeSurface;
  readonly name: string;
  readonly n: number;
}

// ---- §2.6 modules.json -------------------------------------------------------
export interface ModuleEntry {
  readonly id: number;
  readonly file: string;
  readonly factoryFn: number | null;
  readonly deps: readonly number[];
  readonly segment: number;
}

export interface ModulesIndex {
  readonly schema: typeof INDEX_SCHEMA;
  readonly kind: "modules";
  readonly renderIndependent: true;
  readonly modules: readonly ModuleEntry[];
  readonly entry: number | null;
  /** fnIndex (stringified, JSON object keys are strings) -> owning module id. */
  readonly fnOwnership: Readonly<Record<string, number>>;
}

// ---- §2.7 ranges.jsonl -------------------------------------------------------
export interface RangeRow {
  readonly fn: number;
  readonly file: string;
  readonly lines: readonly [number, number];
}

// ---- §1.2 manifest.json -----------------------------------------------------
export interface Manifest {
  readonly schema: typeof ARTIFACT_SCHEMA;
  readonly bundle: {
    readonly sha256: string;
    readonly bytes: number;
    readonly hbcVersion: number;
    readonly functionCount: number;
  };
  readonly producer: {
    readonly hbc2js: string;
    readonly git: string | null;
    readonly passes: unknown;
    readonly strictEnv: boolean;
  };
  readonly render: {
    readonly hash: string;
    readonly form: "segregated" | "flat";
    readonly ts: string;
    readonly overlayHash: string | null;
  };
  readonly index: {
    readonly semanticHash: string;
    readonly builtFor: { readonly bundleSha256: string; readonly producer: string };
  };
  /** §4.3: set when the decompile itself was degraded (e.g. the
   *  E_UNBOUND_IDENT keep-bodies path); absent when clean. */
  readonly degraded?: readonly string[];
}

/** sha256 hex digest of bytes or a utf8 string. */
export function sha256Hex(data: Uint8Array | string): string {
  const h = createHash("sha256");
  h.update(typeof data === "string" ? Buffer.from(data, "utf8") : data);
  return h.digest("hex");
}

/** §1.2 `render.hash`: sha256 over every rendered file, sorted-path order. */
export function hashRenderedFiles(files: ReadonlyMap<string, string>): string {
  const h = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    h.update(name, "utf8");
    h.update("\0");
    h.update(files.get(name)!, "utf8");
    h.update("\0");
  }
  return h.digest("hex");
}

/** §1.2 `index.semanticHash`: sha256 over the semantic-layer files' bytes,
 *  sorted-path order (mirrors `hashRenderedFiles`; `ranges.jsonl` is
 *  presentation-layer and excluded). */
export function hashSemanticFiles(files: ReadonlyMap<string, string>): string {
  return hashRenderedFiles(files);
}

/** Serialise a header + rows as JSONL text (header first, one row per line,
 *  trailing newline) — §1.1's "first line is a header object" rule. */
export function toJsonl(header: unknown, rows: readonly unknown[]): string {
  return [JSON.stringify(header), ...rows.map((r) => JSON.stringify(r))].map((l) => l + "\n").join("");
}
