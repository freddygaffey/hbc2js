// Load/save the on-disk project store — docs/specs/11-project-store.md §2.2.
//
// A record-type file round-trips byte-identically: rows are read as plain
// JSON values (so their original key ORDER is preserved — `JSON.parse`
// populates object keys in source order and `JSON.stringify` walks them in
// insertion order, so a row nobody mutates serialises back exactly as it was
// read) and re-serialised compact (no whitespace, matching the hand-written
// fixture's own style), sorted by `(target, rid)` (§2.2). Same discipline as
// the overlay sidecar's byte-determinism, generalised to four files plus a
// header instead of one.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECT_SCHEMA,
  parseSchemaHeader,
  assertEnvelope,
  compareRows,
  PROJECT_DIR_FILES,
  RECORD_FILE_NAMES,
  type RecordFileKind,
  type CommentsFileRecord,
  type TagsFileRecord,
  type BookmarksFileRecord,
  type FindingsFileRecord,
  type ProjectHeader,
} from "./schema.ts";

export interface RecordFile<T> {
  readonly kind: RecordFileKind;
  readonly rows: readonly T[];
}

function readLines(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
}

/** Load one `project/*.jsonl` file: validate its schema header (refusing an
 *  unknown major, §2.2), validate every row's §2.1 envelope, and return the
 *  rows in on-disk order (already `(target, rid)`-sorted by convention, but
 *  this does not re-sort — `assertSorted` below checks that separately). */
export function loadRecordFile<T extends { readonly rid: string; readonly target: string }>(path: string, kind: RecordFileKind): RecordFile<T> {
  const lines = readLines(path);
  if (lines.length === 0) throw new Error(`${path}: empty record file, missing schema header`);
  const header = parseSchemaHeader(lines[0] as string, kind);
  const rows: T[] = [];
  for (const line of lines.slice(1)) {
    const row = JSON.parse(line) as Record<string, unknown>;
    assertEnvelope(row, path);
    rows.push(row as unknown as T);
  }
  return { kind: header.kind as RecordFileKind, rows };
}

/** Rows must be sorted by `(target, rid)` (§2.2) — throws naming the first
 *  out-of-order pair, mirroring the P1d assertion. */
export function assertSorted<T extends { readonly target: string; readonly rid: string }>(rows: readonly T[], fileLabel: string): void {
  for (let i = 1; i < rows.length; i++) {
    if (compareRows(rows[i - 1]!, rows[i]!) > 0) {
      throw new Error(`${fileLabel}: rows not sorted by (target, rid) at index ${i} (${rows[i - 1]!.rid} before ${rows[i]!.rid})`);
    }
  }
}

/** Serialise one record-type file: schema header line + one compact JSON
 *  line per row, rows sorted by `(target, rid)` (§2.2). Rows are written
 *  exactly as given — callers pass through unmodified parsed objects to get
 *  a byte-identical round trip; a caller minting a NEW row controls its own
 *  key order by construction (object literal order === serialised order). */
export function serializeRecordFile<T extends { readonly target: string; readonly rid: string }>(kind: RecordFileKind, rows: readonly T[]): string {
  const sorted = [...rows].sort(compareRows);
  const lines = [JSON.stringify({ schema: PROJECT_SCHEMA, kind })];
  for (const row of sorted) lines.push(JSON.stringify(row));
  return lines.join("\n") + "\n";
}

export function saveRecordFile<T extends { readonly target: string; readonly rid: string }>(path: string, kind: RecordFileKind, rows: readonly T[]): void {
  writeFileSync(path, serializeRecordFile(kind, rows));
}

// --- project.json ------------------------------------------------------------

export function loadProjectHeader(path: string): ProjectHeader {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const header = parseSchemaHeader(JSON.stringify({ schema: raw.schema, kind: raw.kind }), "header");
  const builtFor = raw.builtFor as { bundleSha256?: unknown } | undefined;
  if (!builtFor || typeof builtFor.bundleSha256 !== "string" || !/^[0-9a-f]{64}$/.test(builtFor.bundleSha256)) {
    throw new Error(`${path}: builtFor.bundleSha256 must be a 64-hex-char sha256`);
  }
  return { schema: header.schema, kind: "header", seq: raw.seq as ProjectHeader["seq"], builtFor: builtFor as ProjectHeader["builtFor"] };
}

/** `project.json`'s fixed, hand-formatted shape (matches the P1 sample
 *  fixture byte-for-byte): top-level pretty-printed, `seq`/`builtFor` inline.
 *  Not a generic pretty-printer — the header has exactly these four fields. */
export function saveProjectHeader(path: string, header: ProjectHeader): void {
  const seq = header.seq;
  const text =
    "{\n" +
    `  "schema": ${JSON.stringify(header.schema)},\n` +
    `  "kind": "header",\n` +
    `  "seq": { "comments": ${seq.comments}, "tags": ${seq.tags}, "bookmarks": ${seq.bookmarks}, "findings": ${seq.findings} },\n` +
    `  "builtFor": { "bundleSha256": ${JSON.stringify(header.builtFor.bundleSha256)} }\n` +
    "}\n";
  writeFileSync(path, text);
}

// --- whole store ---------------------------------------------------------

export interface ProjectStore {
  readonly dir: string;
  readonly header: ProjectHeader;
  readonly comments: readonly CommentsFileRecord[];
  readonly tags: readonly TagsFileRecord[];
  readonly bookmarks: readonly BookmarksFileRecord[];
  readonly findings: readonly FindingsFileRecord[];
}

/** Load a full `<artifact>/project/` directory: the header plus all four
 *  record files, refusing an unknown-major schema anywhere (§2.2) or a
 *  directory that doesn't have exactly the §2.2 file set. Does not resolve
 *  evidence or compute orphan status — those are live, step-4/6 concerns
 *  (§3.3); this is the serialization layer only. */
export function loadProjectStore(dir: string): ProjectStore {
  const files = readdirSync(dir).sort();
  const expected = [...PROJECT_DIR_FILES];
  if (files.join(",") !== expected.join(",")) {
    throw new Error(`${dir}: expected exactly ${JSON.stringify(expected)}, found ${JSON.stringify(files)}`);
  }
  const header = loadProjectHeader(join(dir, "project.json"));
  const comments = loadRecordFile<CommentsFileRecord>(join(dir, RECORD_FILE_NAMES.comments), "comments").rows;
  const tags = loadRecordFile<TagsFileRecord>(join(dir, RECORD_FILE_NAMES.tags), "tags").rows;
  const bookmarks = loadRecordFile<BookmarksFileRecord>(join(dir, RECORD_FILE_NAMES.bookmarks), "bookmarks").rows;
  const findings = loadRecordFile<FindingsFileRecord>(join(dir, RECORD_FILE_NAMES.findings), "findings").rows;
  assertSorted(comments, RECORD_FILE_NAMES.comments);
  assertSorted(tags, RECORD_FILE_NAMES.tags);
  assertSorted(bookmarks, RECORD_FILE_NAMES.bookmarks);
  assertSorted(findings, RECORD_FILE_NAMES.findings);
  return { dir, header, comments, tags, bookmarks, findings };
}

/** Save a full store directory. Writes exactly the files `loadProjectStore`
 *  expects to read back; round-tripping `load -> save` on an untouched store
 *  is byte-identical (proven by the P1 round-trip test). */
export function saveProjectStore(store: ProjectStore): void {
  saveProjectHeader(join(store.dir, "project.json"), store.header);
  saveRecordFile(join(store.dir, RECORD_FILE_NAMES.comments), "comments", store.comments);
  saveRecordFile(join(store.dir, RECORD_FILE_NAMES.tags), "tags", store.tags);
  saveRecordFile(join(store.dir, RECORD_FILE_NAMES.bookmarks), "bookmarks", store.bookmarks);
  saveRecordFile(join(store.dir, RECORD_FILE_NAMES.findings), "findings", store.findings);
}
