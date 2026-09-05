// src/native/schema.ts — the `<artifact>/native/` table contracts.
// docs/specs/27-native-side.md §L1 "Artifact tables (contracts)" + §1.4: every
// file carries a schema header line; a row exists only because bytes said so.
import { createHash } from "node:crypto";

/** §1.4: the header schema id shared by every `native/*.jsonl` file. */
export const NATIVE_SCHEMA = "hbc2js-native/1";

export type NativeKind = "classes" | "methods" | "strings" | "resources" | "assets";
export type NativeSource = "dex" | "axml" | "arsc" | "zip";

/** §1.4: the first line of every native table. */
export interface NativeHeader {
  readonly schema: typeof NATIVE_SCHEMA;
  readonly kind: NativeKind;
  readonly source: NativeSource;
}

export function nativeHeader(kind: NativeKind, source: NativeSource): NativeHeader {
  return { schema: NATIVE_SCHEMA, kind, source };
}

/** An annotation as it appears in DEX, verbatim — no interpretation. */
export interface NativeAnnotation {
  /** Type descriptor, e.g. `Lcom/facebook/react/module/annotations/ReactModule;`. */
  readonly type: string;
  /** Element name -> value, in DEX order. Values are strings/numbers/booleans/
   *  arrays/`null`; a value we cannot decode is `{unresolved:true}`. */
  readonly elements: Record<string, unknown>;
}

/** `native/classes.jsonl`. */
export interface NativeClassRow {
  readonly key: string; // native:type:Lcom/x/Foo;
  readonly name: string; // Lcom/x/Foo;
  readonly super: string | null;
  readonly interfaces: readonly string[];
  readonly access: readonly string[];
  readonly sourceFile: string | null;
  readonly annotations: readonly NativeAnnotation[];
  readonly dex: number;
}

/** `native/methods.jsonl`. */
export interface NativeMethodRow {
  readonly key: string; // native:method:Lcom/x/Foo;->bar(I)V
  readonly class: string; // native:type:...
  readonly name: string;
  readonly proto: string; // (Lcom/x/Y;)V
  readonly access: readonly string[];
  readonly annotations: readonly NativeAnnotation[];
  readonly dex: number;
}

/** `native/strings.jsonl` — the raw DEX string pool, the evidence itself. */
export interface NativeStringRow {
  readonly i: number;
  readonly s: string;
  readonly dex: number;
}

/** A resource value: a literal, or a still-unflattened reference (§L1). */
export type NativeResourceValue = string | number | boolean | { readonly ref: string } | { readonly unresolved: true };

/** `native/resources.jsonl`. */
export interface NativeResourceRow {
  readonly key: string; // native:res:pkg/string/api_url
  readonly value: NativeResourceValue;
  readonly config: string;
  readonly type: string;
}

/** `native/assets.jsonl` — inventory only; bytes are never copied (§4.4). */
export interface NativeAssetRow {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly kind: "json" | "png" | "font" | "other";
}

export interface NativeManifestComponent {
  readonly kind: "activity" | "service" | "receiver" | "provider";
  readonly name: string;
  /** `null` = the attribute is absent and no default is soundly inferable. */
  readonly exported: boolean | null;
  readonly intentFilters: readonly {
    readonly actions: readonly string[];
    readonly categories: readonly string[];
    readonly data: readonly { readonly scheme: string | null; readonly host: string | null; readonly pathPrefix: string | null }[];
  }[];
}

/** `native/manifest.json`. */
export interface NativeManifest {
  readonly package: string | null;
  readonly versionName: string | null;
  readonly versionCode: number | null;
  readonly permissions: readonly string[];
  readonly usesSdk: { readonly min: number | null; readonly target: number | null };
  readonly components: readonly NativeManifestComponent[];
  readonly notes: readonly string[];
}

/** The `native` block spec 27 §L1.4 wires into the artifact `manifest.json`. */
export interface NativeProvenance {
  readonly schema: typeof NATIVE_SCHEMA;
  readonly source: string;
  readonly sourceSha256: string;
  readonly dexCount: number;
  readonly tool: "own-parser";
  readonly files: Record<string, { readonly sha256: string; readonly rows: number }>;
  readonly counts: Record<string, number>;
  readonly notes: readonly string[];
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Header line + one JSON object per row, newline-terminated (spec 10 §1.1). */
export function toNativeJsonl(header: NativeHeader, rows: readonly unknown[]): string {
  const lines = [JSON.stringify(header)];
  for (const r of rows) lines.push(JSON.stringify(r));
  return lines.join("\n") + "\n";
}

/** Inverse of `toNativeJsonl` for a reader that only wants the rows. */
export function parseNativeJsonl(text: string): { header: NativeHeader; rows: unknown[] } {
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error("native table is empty (no schema header line)");
  const header = JSON.parse(lines[0]!) as NativeHeader;
  if (header.schema !== NATIVE_SCHEMA) {
    throw new Error(`unknown native schema ${JSON.stringify(header.schema)} (expected ${NATIVE_SCHEMA}) — refused, not guessed`);
  }
  return { header, rows: lines.slice(1).map((l) => JSON.parse(l) as unknown) };
}

/** Asset kind by extension — a classification of the *path*, never of bytes. */
export function assetKind(path: string): NativeAssetRow["kind"] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".png")) return "png";
  if (lower.endsWith(".ttf") || lower.endsWith(".otf") || lower.endsWith(".woff") || lower.endsWith(".woff2")) return "font";
  return "other";
}
