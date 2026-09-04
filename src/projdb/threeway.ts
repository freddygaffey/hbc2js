// src/projdb/threeway.ts — `hbcproj status`/`diff`/`adopt`/`restore`:
// docs/specs/18-project-storage-integrity.md §10 (three-way conflict
// porcelain) / §R4 step 3. The "base" §10 asks to track per shard is
// already implicit in what step 0/1 stamp onto every shard: a shard's own
// `stateBinding.dbVersion` IS "the DB version this file last honestly
// agreed with" — no separate base table is needed. Three states combine:
//   - file self-consistent (its embedded `contentHash` matches its own
//     content, `verify.ts`'s `checkShard`)  =>  file unchanged since base
//   - file NOT self-consistent (hand-edited) =>  file changed since base
//   - shard's `stateBinding.dbVersion` < the db's current version
//     =>  db changed since base
// which is exactly §10's three-way matrix:
//   file unchanged, db unchanged  -> clean       (nothing to do)
//   file unchanged, db changed    -> lag          ("restore" catches it up)
//   file changed,   db unchanged  -> hand-edit    (clean adopt candidate)
//   file changed,   db changed    -> conflict     (refuse without --force)
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  annotationsShardContent,
  canonicalJson,
  exportWriteEffect,
  findingContentId,
  namesShardContent,
  sortKeysDeep,
  stateBindingOf,
  writeAnnotationsShard,
  writeFindingShardForRid,
  writeNamesShard,
} from "./export.ts";
import { checkShard, listShardFiles, shardLogicalContent } from "./verify.ts";
import { dbAddComment, dbSetBookmark, dbSetFinding, dbSetName, dbSetTag, findingAdapter } from "./annotations.ts";
import type { FindingEvidenceValue } from "./annotations.ts";
import { DbRevisionStore } from "./revision-store.ts";
import type { DbProvenance } from "./revision-store.ts";
import { ArtifactEvidenceResolver, hasResolvingEvidence } from "../project/evidence-resolver.ts";
import type { ArtifactExistenceCheck, EvidenceResolver } from "../project/evidence-resolver.ts";

export type ThreeWayStatus = "clean" | "lag" | "hand-edit" | "conflict" | "corrupt-json";

export interface ThreeWayShard {
  readonly path: string;
  readonly status: ThreeWayStatus;
  readonly detail?: string;
}

type ShardKind = "names" | "annotations" | "findings";

function shardKindOf(path: string): ShardKind | null {
  const dir = basename(dirname(path));
  return dir === "names" || dir === "annotations" || dir === "findings" ? dir : null;
}

/** The shard's own `mod`/`id` key (the filename minus `.json`) — every
 *  writer (`writeNamesShard`/`writeAnnotationsShard`/`writeFindingShardForRid`)
 *  is keyed the same way. */
function shardKeyOf(path: string): string {
  return basename(path).replace(/\.json$/, "");
}

/** Classifies every `analysis/` shard three-way (§10): reuses step 1's
 *  ok/lag/hand-edit/corrupt-json classifier verbatim (`verify.ts`'s
 *  `checkShard`), adding the ONE extra distinction §10 needs that the fast
 *  path doesn't bother with (it doesn't need to — "lag" alone is fine to
 *  self-heal there): a "hand-edit" shard whose OWN recorded `stateBinding.
 *  dbVersion` is ALSO behind the db's current version means the db moved
 *  on too, since this file was last mechanically exported — file changed
 *  AND db changed since the shared base -> "conflict", not a clean adopt
 *  candidate (§10's third case). `ok`/`lag` map straight across as
 *  `"clean"`/`"lag"`. */
export function classifyThreeWay(db: DatabaseSync, projectDir: string): ThreeWayShard[] {
  const currentDbVersion = stateBindingOf(db).dbVersion;
  const analysisDir = join(projectDir, "analysis");
  return listShardFiles(analysisDir).map((path) => {
    const fast = checkShard(path, currentDbVersion);
    if (fast.status === "ok") return { path, status: "clean" as const };
    if (fast.status !== "hand-edit") return { path, status: fast.status, ...(fast.detail !== undefined ? { detail: fast.detail } : {}) };
    let fileDbVersion = -1;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { stateBinding?: { dbVersion?: number } };
      fileDbVersion = parsed.stateBinding?.dbVersion ?? -1;
    } catch {
      /* unparseable — already surfaced as corrupt-json above, never reached */
    }
    if (fileDbVersion < currentDbVersion) {
      return {
        path,
        status: "conflict" as const,
        detail: `${fast.detail ?? "hand-edited"} — AND the db moved on since (file's stateBinding.dbVersion=${fileDbVersion} < db's current ${currentDbVersion}): both changed since the shared base (§10)`,
      };
    }
    return { path, status: "hand-edit" as const, ...(fast.detail !== undefined ? { detail: fast.detail } : {}) };
  });
}

/** A minimal in-order line diff (Myers-lite: LCS over lines) between two
 *  pretty-printed JSON blocks — good enough for the shard sizes this tool
 *  deals with (one module's names/annotations, or one finding). `-` lines
 *  are file-only (the hand edit), `+` lines are db-only (what a mechanical
 *  export would currently produce). */
function lineDiff(a: readonly string[], b: readonly string[]): string[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}

function findingShardContent(db: DatabaseSync, id: string): Record<string, unknown> | null {
  const r = new DbRevisionStore(db, findingAdapter).allRecords().find((rec) => rec.active && findingContentId(rec.target, rec.value.evidence) === id);
  if (r === undefined) return null;
  return { shard: `findings/${id}`, id, target: r.target, kind: "finding", findingNo: r.value.findingNo, severity: r.value.severity, status: r.value.status, claim: r.value.claim, evidence: r.value.evidence, rid: r.rid, ts: r.ts, prov: r.prov };
}

/** What the db would currently, mechanically produce for the shard at
 *  `path` — the SAME logical content (`stateBinding`/`contentHash`
 *  stripped) `writeNamesShard`/`writeAnnotationsShard`/
 *  `writeFindingShardForRid` would write, without touching disk. `null`
 *  when the db has nothing live for this shard at all (e.g. a hand-added
 *  finding file, or a finding whose db record has since been fully
 *  superseded/reverted). */
function liveShardContent(db: DatabaseSync, path: string): Record<string, unknown> | null {
  const kind = shardKindOf(path);
  const key = shardKeyOf(path);
  if (kind === "names") return namesShardContent(db, key);
  if (kind === "annotations") return annotationsShardContent(db, key);
  if (kind === "findings") return findingShardContent(db, key);
  return null;
}

/** Shows the content difference between the on-disk shard at `path` and
 *  what the db would currently produce for it (§10 `diff`) — both sides
 *  with `stateBinding`/`contentHash` stripped (those always differ
 *  trivially and would drown the real diff). */
export function diffShard(db: DatabaseSync, path: string): string {
  const fileText = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const fileLogical = fileText !== undefined ? shardLogicalContent(fileText) : undefined;
  const filePretty = fileLogical !== undefined ? `${JSON.stringify(sortKeysDeep(JSON.parse(fileLogical)), null, 2)}\n` : fileText === undefined ? "(shard file does not exist)\n" : "(shard file is not valid JSON)\n";
  const live = liveShardContent(db, path);
  const livePretty = live !== null ? `${JSON.stringify(sortKeysDeep(live), null, 2)}\n` : "(db has no live content for this shard)\n";
  if (filePretty === livePretty) return `${path}: no difference (file and db agree)\n`;
  return `${path}:\n${lineDiff(filePretty.split("\n"), livePretty.split("\n")).join("\n")}\n`;
}

export interface AdoptResult {
  readonly path: string;
  readonly ok: boolean;
  readonly reason?: string;
  readonly rids?: readonly string[];
}

/** Builds an `ArtifactExistenceCheck` straight off THIS project's own
 *  `ix_*` index tables — no live artifact/bundle needed, everything §11's
 *  `record_finding` evidence gate needs (`hasFn`/`hasString`/`hasModule`)
 *  is already durable in the same `.hbcproj` (schema.sql's `ix_functions`/
 *  `ix_strings`/`ix_modules`). `adopt`'s finding validation is thereby the
 *  SAME rule (`hasResolvingEvidence`, `ArtifactEvidenceResolver`) an MCP
 *  `record_finding` call enforces at write time (`src/project/service.ts`),
 *  just resolved against the db's own index instead of a warm
 *  `ArtifactService`. */
export function dbArtifactExistenceCheck(db: DatabaseSync): ArtifactExistenceCheck {
  return {
    hasFn: (fn) => db.prepare(`SELECT 1 FROM ix_functions WHERE fn = ?`).get(fn) !== undefined,
    hasString: (sid) => db.prepare(`SELECT 1 FROM ix_strings WHERE sid = ?`).get(sid) !== undefined,
    hasModule: (id) => db.prepare(`SELECT 1 FROM ix_modules WHERE id = ?`).get(id) !== undefined,
  };
}

function isEvidenceArray(v: unknown): v is FindingEvidenceValue[] {
  return Array.isArray(v) && v.every((e) => typeof e === "object" && e !== null && typeof (e as { ref?: unknown }).ref === "string" && typeof (e as { role?: unknown }).role === "string");
}

/** Validates + folds a hand-edited shard into the db (§10 `adopt`): the
 *  file becomes authoritative, exactly as if every entry in it had been
 *  written through the normal write verbs (`dbSetName`/`dbSetTag`/
 *  `dbAddComment`/`dbSetBookmark`/`dbSetFinding` — the same functions
 *  every MCP write verb bottoms out in, `src/project/service.ts`), then
 *  re-locked + re-exported + chained (`exportWriteEffect`, the SAME hook
 *  every live MCP write calls right after its own commit) — never a raw
 *  file copy. Rejects (no db writes at all) a shard that: doesn't parse,
 *  is missing required fields, is a `conflict` without `force`, or (for a
 *  findings shard) whose evidence no longer resolves against this
 *  project's own index (§11's write-time gate, re-applied here). */
export function adoptShard(db: DatabaseSync, projectDir: string, path: string, prov: DbProvenance, opts?: { readonly force?: boolean; readonly resolver?: EvidenceResolver }): AdoptResult {
  const currentDbVersion = stateBindingOf(db).dbVersion;
  const fast = checkShard(path, currentDbVersion);
  if (fast.status === "corrupt-json") return { path, ok: false, reason: `malformed shard — ${fast.detail}` };
  if (fast.status === "ok") return { path, ok: false, reason: "nothing to adopt — file and db already agree" };
  if (fast.status === "lag") return { path, ok: false, reason: "nothing to adopt — file is unchanged, only the db moved on; run 'restore' to catch it up" };
  // fast.status === "hand-edit": classify further to tell a clean adopt
  // apart from a conflict (both base halves diverged, §10).
  const three = classifyThreeWay(db, projectDir).find((s) => s.path === path);
  if (three?.status === "conflict" && opts?.force !== true) {
    return { path, ok: false, reason: `conflict — both the file and the db changed since the last shared state; refuse without --force (${three.detail ?? ""})` };
  }

  const kind = shardKindOf(path);
  if (kind === null) return { path, ok: false, reason: `malformed shard — unrecognised shard directory for ${path}` };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    return { path, ok: false, reason: `malformed shard — ${e instanceof Error ? e.message : String(e)}` };
  }

  const resolver = opts?.resolver ?? new ArtifactEvidenceResolver(dbArtifactExistenceCheck(db));
  const rids: string[] = [];

  if (kind === "names") {
    const entries = parsed.entries;
    if (entries === null || typeof entries !== "object" || Array.isArray(entries)) return { path, ok: false, reason: "malformed shard — 'entries' must be an object" };
    for (const [target, raw] of Object.entries(entries as Record<string, unknown>)) {
      const name = (raw as { name?: unknown } | undefined)?.name;
      if (typeof target !== "string" || target === "" || typeof name !== "string") {
        return { path, ok: false, reason: `malformed shard — entry for '${target}' is missing a string 'name'` };
      }
    }
    for (const [target, raw] of Object.entries(entries as Record<string, unknown>)) {
      const { record } = dbSetName(db, target, (raw as { name: string }).name, prov);
      rids.push(record.rid);
    }
  } else if (kind === "annotations") {
    const tags = parsed.tags;
    const comments = parsed.comments;
    const bookmarks = parsed.bookmarks;
    if (!Array.isArray(tags) || !Array.isArray(comments) || !Array.isArray(bookmarks)) {
      return { path, ok: false, reason: "malformed shard — 'tags'/'comments'/'bookmarks' must be arrays" };
    }
    for (const t of tags as Record<string, unknown>[]) {
      if (typeof t.target !== "string" || typeof t.tag !== "string") return { path, ok: false, reason: "malformed shard — a tag entry is missing 'target'/'tag'" };
    }
    for (const c of comments as Record<string, unknown>[]) {
      if (typeof c.target !== "string" || typeof c.body !== "string") return { path, ok: false, reason: "malformed shard — a comment entry is missing 'target'/'body'" };
    }
    for (const b of bookmarks as Record<string, unknown>[]) {
      if (typeof b.target !== "string") return { path, ok: false, reason: "malformed shard — a bookmark entry is missing 'target'" };
    }
    for (const t of tags as { target: string; tag: string; note?: string }[]) {
      const { record } = dbSetTag(db, t.target, t.tag, prov, t.note !== undefined ? { note: t.note } : undefined);
      rids.push(record.rid);
    }
    for (const c of comments as { target: string; body: string; range?: { line: number; col?: number } }[]) {
      const { record } = dbAddComment(db, c.target, c.body, prov, c.range !== undefined ? { range: c.range } : undefined);
      rids.push(record.rid);
    }
    for (const b of bookmarks as { target: string; label?: string }[]) {
      const { record } = dbSetBookmark(db, b.target, prov, b.label !== undefined ? { label: b.label } : undefined);
      rids.push(record.rid);
    }
  } else {
    // findings
    const target = parsed.target;
    const evidence = parsed.evidence;
    const findingNo = parsed.findingNo;
    const severity = parsed.severity;
    const status = parsed.status;
    const claim = parsed.claim;
    if (typeof target !== "string" || typeof findingNo !== "number" || typeof severity !== "string" || typeof status !== "string" || typeof claim !== "string" || !isEvidenceArray(evidence)) {
      return { path, ok: false, reason: "malformed shard — a findings shard needs string 'target'/'severity'/'status'/'claim', a numeric 'findingNo', and an 'evidence' array of {ref, role}" };
    }
    if (!hasResolvingEvidence(evidence, resolver)) {
      return { path, ok: false, reason: `rejected — this finding's evidence no longer resolves against the project's index (spec 11 §4.1): ${evidence.map((e) => e.ref).join(", ") || "(no evidence)"}` };
    }
    const { record } = dbSetFinding(db, target, { findingNo, severity, status, claim, evidence }, prov);
    rids.push(record.rid);
  }

  for (const rid of rids) exportWriteEffect(db, projectDir, Number(rid));
  return { path, ok: true, rids };
}

export interface RestoreResult {
  readonly path: string;
  readonly restored: boolean;
  readonly deleted?: boolean;
}

/** Discards whatever is on disk at `path` (a hand edit, a conflict, or
 *  just a stale-lagging file) and re-materialises it straight from the db
 *  (§10 `restore`) — the exact per-shard writer `exportProject`/
 *  `exportWriteEffect` use, never the WHOLE project's bulk export, so
 *  restoring one shard never touches (never silently overwrites, §8) any
 *  OTHER shard's own pending hand edit. A findings shard whose db record
 *  no longer has anything live under that content-hash id (fully
 *  superseded/reverted elsewhere) is deleted instead — the db's honest
 *  answer for that id is "nothing", not a guess. */
export function restoreShard(db: DatabaseSync, projectDir: string, path: string): RestoreResult {
  const kind = shardKindOf(path);
  const key = shardKeyOf(path);
  const analysisDir = join(projectDir, "analysis");
  const binding = stateBindingOf(db);
  const result = { written: [] as string[], unchanged: [] as string[] };
  if (kind === "names") {
    writeNamesShard(db, analysisDir, binding, key, result);
    return { path, restored: true };
  }
  if (kind === "annotations") {
    writeAnnotationsShard(db, analysisDir, binding, key, result);
    return { path, restored: true };
  }
  // findings
  const r = new DbRevisionStore(db, findingAdapter).allRecords().find((rec) => rec.active && findingContentId(rec.target, rec.value.evidence) === key);
  if (r === undefined) {
    if (existsSync(path)) {
      rmSync(path);
      return { path, restored: true, deleted: true };
    }
    return { path, restored: true, deleted: true };
  }
  writeFindingShardForRid(db, analysisDir, binding, Number(r.rid), result);
  return { path, restored: true };
}

/** Every `analysis/` shard path currently on disk, in the same order
 *  `classifyThreeWay`/`hbcproj status` walks them — the `--all` targets
 *  for `adopt`/`restore`. */
export function allShardPaths(projectDir: string): string[] {
  return listShardFiles(join(projectDir, "analysis"));
}

// re-exported so `canonicalJson` stays a single source of truth for CLI
// callers that need to pretty-print a shard the same way this module does.
export { canonicalJson };
