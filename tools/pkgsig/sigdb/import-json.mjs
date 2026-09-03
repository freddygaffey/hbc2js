#!/usr/bin/env node
// tools/pkgsig/sigdb/import-json.mjs — one-shot importer for the legacy schema-2
// signature JSON store (docs/specs/15-sigdb-schema.md §3): sha256-keyed,
// idempotent + resumable via `import_log` (each file's log row commits in the
// SAME transaction as its data rows — a crash can never leave `status='ok'`
// without the rows, §12 T1 hardening), batch transactions, a derived-stats
// pass, and the 4-part completeness check (§3.4).
//
// The completeness/round-trip reader below is a deliberately INDEPENDENT read
// path from `src/deps/sigdb-sql.ts`'s `insertFingerprint` — plain SELECTs,
// its own hex/JSON conversions, sharing no serialization helper with the
// writer (§12 review item 6: a symmetric writer/reader bug must not be able
// to self-verify). It shares only `openSigDb` (needed to reach the same DB
// file) and the interned `newShapeCache` writer entry points.
//
// Usage:
//   import-json.mjs <json-db-dir> <out.sqlite> [--verify] [--seed N] [--batch-size N]
//   import-json.mjs <json-db-dir> <out.sqlite> --verify-only   (skip the import loop)

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openSigDb,
  insertFingerprint,
  newShapeCache,
  rebuildDerived,
} from "../../../src/deps/sigdb-sql.ts";

const FILENAME_RE = /^(.*)@([^@]+)__hbc(\d+)\.json$/;

export function parseSigFilename(name) {
  const m = FILENAME_RE.exec(name);
  if (m === null) return null;
  return { pkg: m[1].replace(/__/g, "/"), version: m[2], hbcVersion: Number(m[3]) };
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Lists top-level `*.json` (excluding `index.json`) and `_baselines/*.json`
 *  under `dir` (§3 step 1). Returns per-hbc_version counts alongside the
 *  file lists so callers don't re-derive them. */
export function enumerateSourceFiles(dir) {
  const topLevel = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json") || name === "index.json") continue;
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue;
    topLevel.push({ relPath: name, path: full, parsed: parseSigFilename(name) });
  }
  const baselines = [];
  const baselineDir = join(dir, "_baselines");
  if (existsSync(baselineDir)) {
    for (const name of readdirSync(baselineDir).sort()) {
      if (!name.endsWith(".json")) continue;
      const full = join(baselineDir, name);
      if (!statSync(full).isFile()) continue;
      baselines.push({ relPath: join("_baselines", name), path: full, parsed: parseSigFilename(name) });
    }
  }
  const byHbcVersion = new Map();
  for (const f of [...topLevel, ...baselines]) {
    const v = f.parsed?.hbcVersion ?? null;
    byHbcVersion.set(v, (byHbcVersion.get(v) ?? 0) + 1);
  }
  return { topLevel, baselines, byHbcVersion };
}

function classifyError(e) {
  const msg = String((e && e.message) || e);
  if (msg.startsWith("hash-format")) return "hash-format";
  if (/^insertFingerprint: unsupported schema/.test(msg)) return "schema";
  if (e instanceof SyntaxError || /json/i.test(msg)) return "parse";
  if (/UNIQUE constraint/i.test(msg)) return "constraint";
  return "other";
}

/** The import loop (§3 step 2). Resumable + idempotent: a file whose path is
 *  already in `import_log` with the same sha256 and `status='ok'` is
 *  skipped; a file whose path is known but whose sha256 changed is refused
 *  as `error:changed-file` (never silently replaces, A3); everything else is
 *  parsed, validated, and inserted, `batchSize` files per transaction. */
export function importDirectory(dir, dbPath, opts = {}) {
  const batchSize = opts.batchSize ?? 200;
  const log = opts.log ?? (() => {});
  const db = openSigDb(dbPath);
  const { topLevel, baselines, byHbcVersion } = enumerateSourceFiles(dir);
  const files = [
    ...topLevel.map((f) => ({ ...f, isBaseline: false })),
    ...baselines.map((f) => ({ ...f, isBaseline: true })),
  ];
  const cache = newShapeCache();
  const stmtLookup = db.prepare(
    "SELECT source_sha256, status FROM import_log WHERE source_file = ?",
  );
  const stmtLog = db.prepare(
    `INSERT INTO import_log (source_file, source_sha256, fp_id, status, imported_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_file) DO UPDATE SET
       source_sha256 = excluded.source_sha256, fp_id = excluded.fp_id,
       status = excluded.status, imported_at = excluded.imported_at`,
  );

  let imported = 0;
  let skipped = 0;
  let errors = 0;
  const errorFiles = [];

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    db.exec("BEGIN;");
    try {
      for (const file of batch) {
        const sha = sha256File(file.path);
        const existing = stmtLookup.get(file.relPath);
        if (existing !== undefined) {
          if (existing.source_sha256 === sha && existing.status === "ok") {
            skipped++;
            continue;
          }
          if (existing.source_sha256 !== sha) {
            stmtLog.run(file.relPath, sha, null, "error:changed-file", new Date().toISOString());
            errors++;
            errorFiles.push(file.relPath);
            continue;
          }
          // same sha, previously failed: fall through and retry.
        }
        let fpId = null;
        let status = "ok";
        try {
          const sig = JSON.parse(readFileSync(file.path, "utf8"));
          fpId = insertFingerprint(db, sig, cache, {
            sourceFile: file.relPath,
            sourceSha256: sha,
            isBaselineFile: file.isBaseline,
          });
          imported++;
        } catch (e) {
          status = `error:${classifyError(e)}`;
          errors++;
          errorFiles.push(file.relPath);
        }
        stmtLog.run(file.relPath, sha, fpId, status, new Date().toISOString());
      }
      db.exec("COMMIT;");
    } catch (e) {
      db.exec("ROLLBACK;");
      throw e;
    }
    log({ processed: Math.min(i + batchSize, files.length), total: files.length });
  }

  rebuildDerived(db);
  db.exec("VACUUM;");

  return {
    db,
    totalEnumerated: files.length,
    topLevelCount: topLevel.length,
    baselineCount: baselines.length,
    byHbcVersion,
    imported,
    skipped,
    errors,
    errorFiles,
  };
}

// ---------------------------------------------------------------------------
// Completeness check (§3.4) + independent round-trip reconstruction.
// ---------------------------------------------------------------------------

function hexOf(blob) {
  return Buffer.from(blob).toString("hex");
}

/** Independent read path: rebuilds a schema-2 `SigDbFile` object from plain
 *  SELECTs against `fp_id`, sharing no code with `insertFingerprint`. */
export function reconstructFingerprint(db, fpId) {
  const fp = db
    .prepare(
      `SELECT f.*, pv.version AS pv_version, p.name AS pkg_name
       FROM fingerprints f
       JOIN package_versions pv ON pv.pv_id = f.pv_id
       JOIN packages p ON p.pkg_id = pv.pkg_id
       WHERE f.fp_id = ?`,
    )
    .get(fpId);
  if (fp === undefined) return null;

  const subtractedBaselines = db
    .prepare("SELECT baseline_ref FROM fingerprint_baselines WHERE fp_id = ? ORDER BY ordinal")
    .all(fpId)
    .map((r) => r.baseline_ref);

  const functions = db
    .prepare(
      `SELECT ff.fn_index AS idx, s.exact_hash, s.fuzzy_hash, s.string_set_hash, s.name,
              s.param_count, s.instr_count, s.string_count
       FROM fingerprint_functions ff JOIN function_shapes s ON s.shape_id = ff.shape_id
       WHERE ff.fp_id = ? ORDER BY ff.fn_index`,
    )
    .all(fpId)
    .map((r) => ({
      index: r.idx,
      name: r.name,
      paramCount: r.param_count,
      instrCount: r.instr_count,
      exactHash: hexOf(r.exact_hash),
      fuzzyHash: hexOf(r.fuzzy_hash),
      stringSetHash: hexOf(r.string_set_hash),
      stringCount: r.string_count,
    }));

  const modules = db
    .prepare("SELECT * FROM modules WHERE fp_id = ? ORDER BY module_ordinal")
    .all(fpId)
    .map((r) => ({
      factoryFunctionIndex: r.factory_function_index,
      localModuleId: r.local_module_id,
      depCount: r.dep_count,
      depIds: r.dep_ids != null ? JSON.parse(r.dep_ids) : null,
      factoryExactHash: r.factory_exact_hash != null ? hexOf(r.factory_exact_hash) : null,
      factoryFuzzyHash: r.factory_fuzzy_hash != null ? hexOf(r.factory_fuzzy_hash) : null,
      nestedFunctionCount: r.nested_function_count,
      functionSetHash: hexOf(r.function_set_hash),
      factoryIsBaseline: !!r.factory_is_baseline,
    }));

  return {
    schema: fp.source_schema,
    package: fp.pkg_name,
    version: fp.pv_version,
    hbcVersion: fp.hbc_version,
    totalFunctions: fp.total_functions,
    rawFunctionCount: fp.raw_function_count,
    subtractedBaselines,
    functions,
    modules,
    toolchainBaseline: !!fp.toolchain_baseline,
    provenance: {
      packageSha256: fp.package_sha256,
      metroVersion: fp.metro_version,
      reactNativeVersion: fp.react_native_version,
      hermescVersion: fp.hermesc_version,
      hermescRnEra: fp.hermesc_rn_era,
      repoCommit: fp.repo_commit,
      builtAt: fp.built_at,
    },
  };
}

// Deterministic seeded PRNG (mulberry32) so the round-trip sample is
// reproducible across runs/machines for the same seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededSample(n, count, seed) {
  const idx = Array.from({ length: count }, (_, i) => i);
  const rand = mulberry32(seed);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, Math.min(n, count)).sort((a, b) => a - b);
}

function deepEqualJson(a, b) {
  // key-order-insensitive by construction: JSON.stringify with sorted keys.
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** The 4-part completeness check (§3.4). `dir` and `dbPath` are re-read
 *  independently of any earlier `importDirectory` call in the same process
 *  — this never trusts a remembered count, it re-enumerates (§7 T1). */
export function verifyCompleteness(dir, dbPath, opts = {}) {
  const seed = opts.seed ?? 1;
  const sampleFraction = opts.sampleFraction ?? 0.01;
  const db = openSigDb(dbPath);
  const problems = [];

  const { topLevel, baselines, byHbcVersion } = enumerateSourceFiles(dir);
  const enumeratedTotal = topLevel.length + baselines.length;

  // (a) counts.
  const dbTotal = db
    .prepare("SELECT COUNT(*) AS n FROM fingerprints WHERE quarantined IS NULL")
    .get().n;
  if (dbTotal !== enumeratedTotal) {
    problems.push(`count mismatch: enumerated ${enumeratedTotal} files, DB has ${dbTotal} non-quarantined fingerprints`);
  }
  const dbByHbc = new Map(
    db
      .prepare(
        "SELECT hbc_version AS v, COUNT(*) AS n FROM fingerprints WHERE quarantined IS NULL GROUP BY hbc_version",
      )
      .all()
      .map((r) => [r.v, r.n]),
  );
  for (const [v, n] of byHbcVersion) {
    if (v === null) continue; // unparsed filenames don't map to an hbc_version bucket
    if (dbByHbc.get(v) !== n) {
      problems.push(`hbc_version ${v}: enumerated ${n} files, DB has ${dbByHbc.get(v) ?? 0}`);
    }
  }

  // (b) zero error:* rows.
  const errorRows = db
    .prepare("SELECT source_file, status FROM import_log WHERE status LIKE 'error:%'")
    .all();
  for (const r of errorRows) problems.push(`import_log error: ${r.source_file} (${r.status})`);

  // (c) index.json reconciliation, when present.
  const indexPath = join(dir, "index.json");
  let indexChecked = 0;
  if (existsSync(indexPath)) {
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    const stmt = db.prepare(
      `SELECT f.total_functions AS total_functions, f.is_baseline_file AS is_baseline_file
       FROM fingerprints f
       JOIN package_versions pv ON pv.pv_id = f.pv_id
       JOIN packages p ON p.pkg_id = pv.pkg_id
       WHERE p.name = ? AND pv.version = ? AND f.hbc_version = ? AND f.quarantined IS NULL`,
    );
    for (const entry of index.entries ?? []) {
      indexChecked++;
      const row = stmt.get(entry.package, entry.version, entry.hbcVersion);
      if (row === undefined) {
        problems.push(`index.json entry unresolved: ${entry.package}@${entry.version} hbc${entry.hbcVersion}`);
        continue;
      }
      if (row.total_functions !== entry.totalFunctions || !!row.is_baseline_file !== !!entry.isBaseline) {
        problems.push(`index.json entry mismatch: ${entry.package}@${entry.version} hbc${entry.hbcVersion}`);
      }
    }
  }

  // (d) round-trip sample: seeded fraction of top-level files + ALL baselines.
  const sampleSize = Math.max(1, Math.round(topLevel.length * sampleFraction));
  const sampleIdx = new Set(seededSample(sampleSize, topLevel.length, seed));
  const toCheck = [
    ...topLevel.filter((_, i) => sampleIdx.has(i)),
    ...baselines,
  ];
  const stmtFp = db.prepare("SELECT fp_id FROM import_log WHERE source_file = ? AND status = 'ok'");
  let roundtripChecked = 0;
  let roundtripMismatches = 0;
  for (const file of toCheck) {
    const row = stmtFp.get(file.relPath);
    if (row === undefined || row.fp_id === null) {
      problems.push(`round-trip: ${file.relPath} has no successful import_log/fp_id`);
      roundtripMismatches++;
      continue;
    }
    const original = JSON.parse(readFileSync(file.path, "utf8"));
    const reconstructed = reconstructFingerprint(db, row.fp_id);
    roundtripChecked++;
    if (!deepEqualJson(original, reconstructed)) {
      roundtripMismatches++;
      problems.push(`round-trip mismatch: ${file.relPath}`);
    }
  }

  return {
    ok: problems.length === 0,
    enumeratedTotal,
    dbTotal,
    errorCount: errorRows.length,
    indexChecked,
    roundtripChecked,
    roundtripMismatches,
    problems,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function isMain() {
  return process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const verifyOnly = args.includes("--verify-only");
  const verify = verifyOnly || args.includes("--verify");
  const [dir, dbPath] = positional;
  if (dir === undefined || dbPath === undefined) {
    console.error("usage: import-json.mjs <json-db-dir> <out.sqlite> [--verify] [--verify-only]");
    process.exit(2);
  }
  if (!verifyOnly) {
    const result = importDirectory(dir, dbPath, {
      log: ({ processed, total }) => console.error(`  imported ${processed}/${total}`),
    });
    console.log(
      `enumerated ${result.totalEnumerated} (${result.topLevelCount} top-level + ${result.baselineCount} baselines); ` +
        `imported ${result.imported}, skipped ${result.skipped}, errors ${result.errors}`,
    );
    if (result.errors > 0) {
      console.error(`error files:\n${result.errorFiles.join("\n")}`);
    }
  }
  if (verify) {
    const report = verifyCompleteness(dir, dbPath);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exit(1);
  }
}
