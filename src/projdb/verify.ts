// src/projdb/verify.ts — `hbcproj verify [--full]`: docs/specs/18-project-
// storage-integrity.md §6 step 1 / §8 (amended) / §9 `verify` verb / §R4
// step 1. Two fast, self-contained checks (no DB round-trip needed) plus a
// DB-aware classification, plus `--full`'s deeper validators (§R3 metric 1
// substrate reused from rebuild.ts/export.ts).
//
// §8 amendment (Reviewer edit R1) is the crux of this module: on a shard
// whose on-disk content diverges from what the DB would produce right now,
// distinguish
//   - LAG: the file is still self-consistent (its own embedded `contentHash`
//     matches a hash recomputed over its own content) but its `stateBinding.
//     dbVersion` is behind the DB's current version — a plain "hasn't been
//     re-exported since the last write yet" gap. The DB wins; safe to
//     silently re-export (crash recovery, §8 "Live").
//   - HAND EDIT: the file's own `contentHash` does NOT match its content —
//     someone edited the JSON directly (or bit-rot), so the file no longer
//     even agrees with itself. Never auto-overwritten; surfaced for the
//     `adopt`/`restore` flow (§10, R4 step 3) instead.
// This distinction needs NOTHING from the DB for the hand-edit half (the
// shard is self-inconsistent, full stop); the DB is only consulted to tell
// a stale-but-honest file (lag) apart from a genuinely up-to-date one (ok).
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, exportProject, sha256Hex, stateBindingOf } from "./export.ts";
import { rebuildProject } from "./rebuild.ts";
import { openProjectDb } from "./db.ts";

export type ShardStatus = "ok" | "lag" | "hand-edit" | "corrupt-json";

export interface ShardCheck {
  readonly path: string;
  readonly status: ShardStatus;
  readonly detail?: string;
}

export interface LogChainCheck {
  readonly path: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface FullVerifyResult {
  /** Rebuilding a scratch DB from `analysis/`+`log/` and re-exporting it
   *  reproduces the on-disk shards byte-identically (§R3 metric 1 — the
   *  same proof `tests/projdb/rebuild-verify.test.ts` runs directly). */
  readonly roundTrip: boolean;
  /** Exporting the LIVE `db` right now (without touching disk) matches what
   *  is actually committed under `analysis/`+`log/` — a coarser, DB-vs-disk
   *  agreement check independent of the hash/lag classification above. */
  readonly dbShardsAgree: boolean;
  readonly detail: readonly string[];
}

export interface VerifyResult {
  readonly shards: readonly ShardCheck[];
  readonly logChain: readonly LogChainCheck[];
  readonly full?: FullVerifyResult;
  /** True iff nothing here needs human attention: no corrupt/hand-edited
   *  shard, no broken log chain, and (when `--full` ran) both deep
   *  validators passed. `lag` alone does NOT fail verify — it is the
   *  expected, self-healing state between a DB write and its export. */
  readonly ok: boolean;
}

function listShardFiles(analysisDir: string): string[] {
  const out: string[] = [];
  for (const sub of ["names", "annotations", "findings"]) {
    const dir = join(analysisDir, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) out.push(join(dir, f));
  }
  return out;
}

function checkShard(path: string, currentDbVersion: number): ShardCheck {
  const rel = path;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    return { path: rel, status: "corrupt-json", detail: e instanceof Error ? e.message : String(e) };
  }
  const recordedHash = parsed.contentHash;
  const { contentHash: _drop, ...rest } = parsed;
  const recomputed = sha256Hex(canonicalJson(rest));
  if (typeof recordedHash !== "string" || recomputed !== recordedHash) {
    return { path: rel, status: "hand-edit", detail: `recorded contentHash '${String(recordedHash)}' != recomputed '${recomputed}' — content was edited without re-locking the hash` };
  }
  const binding = rest.stateBinding as { dbVersion?: number } | undefined;
  const dbVersion = binding?.dbVersion ?? -1;
  if (dbVersion < currentDbVersion) {
    return { path: rel, status: "lag", detail: `shard stateBinding.dbVersion=${dbVersion} < db's current ${currentDbVersion}` };
  }
  return { path: rel, status: "ok" };
}

/** Verifies the `log/*.jsonl` hash chain (§5) is continuous: every entry's
 *  own `hash` matches a hash recomputed over its content, and every entry's
 *  `prevHash` equals the hash of the entry immediately before it — the
 *  chain spans day-file boundaries (export.ts's `exportLog`), so files are
 *  walked in name order and the running hash carries across files. */
function checkLogChain(logDir: string): LogChainCheck[] {
  if (!existsSync(logDir)) return [];
  const out: LogChainCheck[] = [];
  let prevHash = "genesis";
  for (const f of readdirSync(logDir).filter((f) => f.endsWith(".jsonl")).sort()) {
    const path = join(logDir, f);
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
    let fileOk = true;
    let detail: string | undefined;
    for (const [i, line] of lines.entries()) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch (e) {
        fileOk = false;
        detail = `line ${i}: invalid JSON (${e instanceof Error ? e.message : String(e)})`;
        break;
      }
      if (entry.prevHash !== prevHash) {
        fileOk = false;
        detail = `line ${i} (seq ${String(entry.seq)}): prevHash '${String(entry.prevHash)}' != expected '${prevHash}'`;
        break;
      }
      const { hash: recordedHash, ...rest } = entry;
      const recomputed = sha256Hex(canonicalJson(rest));
      if (recomputed !== recordedHash) {
        fileOk = false;
        detail = `line ${i} (seq ${String(entry.seq)}): recorded hash '${String(recordedHash)}' != recomputed '${recomputed}'`;
        break;
      }
      prevHash = recomputed;
    }
    out.push({ path, ok: fileOk, ...(detail !== undefined ? { detail } : {}) });
    if (!fileOk) break; // chain is broken; later files can't be checked meaningfully
  }
  return out;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Compares two directory trees (relative path + content); returns a
 *  human-readable diff list, empty iff they are byte-identical. */
function diffDirs(a: string, b: string): string[] {
  const out: string[] = [];
  const aFiles = new Map(walk(a).map((p) => [relative(a, p), p]));
  const bFiles = new Map(walk(b).map((p) => [relative(b, p), p]));
  for (const [rel, pa] of aFiles) {
    const pb = bFiles.get(rel);
    if (pb === undefined) {
      out.push(`${rel}: present under ${a}, missing under ${b}`);
      continue;
    }
    if (readFileSync(pa, "utf8") !== readFileSync(pb, "utf8")) out.push(`${rel}: content differs`);
  }
  for (const rel of bFiles.keys()) {
    if (!aFiles.has(rel)) out.push(`${rel}: present under ${b}, missing under ${a}`);
  }
  return out;
}

function runFull(db: DatabaseSync, projectDir: string): FullVerifyResult {
  const detail: string[] = [];

  // Validator 1: DB<->shards agreement — export the LIVE db into a scratch
  // dir and diff against what is actually committed on disk.
  const liveScratch = mkdtempSync(join(tmpdir(), "hbc2js-verify-live-"));
  let dbShardsAgree = true;
  try {
    exportProject(db, liveScratch);
    const liveDiff = diffDirs(join(liveScratch, "analysis"), join(projectDir, "analysis")).concat(diffDirs(join(liveScratch, "log"), join(projectDir, "log")));
    if (liveDiff.length > 0) {
      dbShardsAgree = false;
      detail.push(...liveDiff.map((d) => `db-vs-shards: ${d}`));
    }
  } finally {
    rmSync(liveScratch, { recursive: true, force: true });
  }

  // Validator 2: round-trip — rebuild a scratch DB from the on-disk shards
  // and re-export it; must reproduce the same shards byte-identically
  // (§R3 metric 1).
  const rebuiltDbPath = join(mkdtempSync(join(tmpdir(), "hbc2js-verify-rebuild-")), "project.hbcproj");
  const rebuiltScratch = mkdtempSync(join(tmpdir(), "hbc2js-verify-rebuilt-export-"));
  let roundTrip = true;
  try {
    const scratchDb = openProjectDb(rebuiltDbPath);
    try {
      rebuildProject(scratchDb, projectDir);
      exportProject(scratchDb, rebuiltScratch);
    } finally {
      scratchDb.close();
    }
    const rtDiff = diffDirs(join(rebuiltScratch, "analysis"), join(projectDir, "analysis")).concat(diffDirs(join(rebuiltScratch, "log"), join(projectDir, "log")));
    if (rtDiff.length > 0) {
      roundTrip = false;
      detail.push(...rtDiff.map((d) => `round-trip: ${d}`));
    }
  } finally {
    rmSync(rebuiltScratch, { recursive: true, force: true });
    rmSync(rebuiltDbPath, { force: true });
  }

  return { roundTrip, dbShardsAgree, detail };
}

/** Runs the §8/§9 integrity checks for the project at `projectDir` against
 *  its open `db`. Default (fast): per-shard hash self-consistency + lag
 *  classification, and the `log/` hash chain. `--full` additionally proves
 *  DB<->shard agreement and rebuild round-trip fidelity (§R3 metric 1). */
export function verifyProject(db: DatabaseSync, projectDir: string, opts?: { readonly full?: boolean }): VerifyResult {
  const analysisDir = join(projectDir, "analysis");
  const logDir = join(projectDir, "log");
  const currentDbVersion = stateBindingOf(db).dbVersion;

  const shards = listShardFiles(analysisDir).map((p) => checkShard(p, currentDbVersion));
  const logChain = checkLogChain(logDir);

  const full = opts?.full === true ? runFull(db, projectDir) : undefined;

  const ok = shards.every((s) => s.status === "ok" || s.status === "lag") && logChain.every((c) => c.ok) && (full === undefined || (full.roundTrip && full.dbShardsAgree));

  return { shards, logChain, ...(full !== undefined ? { full } : {}), ok };
}
