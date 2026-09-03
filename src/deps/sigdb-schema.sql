-- src/deps/sigdb-schema.sql — hbc2js sigdb v3 (docs/specs/15-sigdb-schema.md §2).
-- Applied verbatim by openSigDb() on a fresh DB. Do not hand-edit a live DB;
-- schema changes are an ALTER TABLE + backfill (see spec §0).

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE packages (
  pkg_id       INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  scope        TEXT,
  bare_name    TEXT NOT NULL,
  tier         INTEGER,
  weekly_downloads      INTEGER,
  downloads_measured_at TEXT,
  dependents_count      INTEGER,
  curated_rank INTEGER,
  curated_reason TEXT
);

CREATE TABLE package_versions (
  pv_id        INTEGER PRIMARY KEY,
  pkg_id       INTEGER NOT NULL REFERENCES packages(pkg_id),
  version      TEXT NOT NULL,
  semver_major INTEGER, semver_minor INTEGER, semver_patch INTEGER,
  semver_prerelease TEXT,
  published_at TEXT,
  UNIQUE (pkg_id, version)
);

CREATE TABLE fingerprints (
  fp_id        INTEGER PRIMARY KEY,
  pv_id        INTEGER NOT NULL REFERENCES package_versions(pv_id),
  hbc_version  INTEGER NOT NULL,
  variant      TEXT NOT NULL DEFAULT '',
  source_schema INTEGER NOT NULL,
  total_functions    INTEGER NOT NULL,
  raw_function_count INTEGER,
  toolchain_baseline INTEGER NOT NULL DEFAULT 0,
  is_baseline_file   INTEGER NOT NULL DEFAULT 0,
  bulk_build_fix_version INTEGER,
  quarantined  TEXT,
  package_sha256 TEXT, metro_version TEXT, react_native_version TEXT,
  hermesc_version INTEGER, hermesc_rn_era TEXT, repo_commit TEXT, built_at TEXT,
  bundler TEXT,
  bundler_version TEXT, babel_version TEXT, node_version TEXT,
  minified INTEGER,
  builder TEXT,
  build_host TEXT,
  sum_instr_count INTEGER, module_count INTEGER,
  non_baseline_module_count INTEGER, distinct_exact_hashes INTEGER,
  source_file TEXT, source_sha256 TEXT,
  imported_at TEXT NOT NULL,
  UNIQUE (pv_id, hbc_version, variant, is_baseline_file)
);

CREATE TABLE fingerprint_baselines (
  fp_id INTEGER NOT NULL REFERENCES fingerprints(fp_id),
  ordinal INTEGER NOT NULL,
  baseline_ref TEXT NOT NULL,
  PRIMARY KEY (fp_id, ordinal)
) WITHOUT ROWID;

CREATE TABLE function_shapes (
  shape_id INTEGER PRIMARY KEY,
  exact_hash BLOB NOT NULL, fuzzy_hash BLOB NOT NULL, string_set_hash BLOB NOT NULL,
  name TEXT NOT NULL, param_count INTEGER NOT NULL,
  instr_count INTEGER NOT NULL, string_count INTEGER NOT NULL,
  opcode_seq_hash BLOB,
  bytecode_size INTEGER,
  block_count INTEGER, loop_count INTEGER, try_count INTEGER, switch_count INTEGER,
  env_slot_count INTEGER,
  flags INTEGER,
  strings_json TEXT,
  strings_truncated INTEGER,
  UNIQUE (exact_hash, fuzzy_hash, string_set_hash, name,
          param_count, instr_count, string_count)
);

CREATE TABLE fingerprint_functions (
  fp_id INTEGER NOT NULL REFERENCES fingerprints(fp_id),
  fn_index INTEGER NOT NULL,
  shape_id INTEGER NOT NULL REFERENCES function_shapes(shape_id),
  PRIMARY KEY (fp_id, fn_index)
) WITHOUT ROWID;

CREATE TABLE modules (
  fp_id INTEGER NOT NULL REFERENCES fingerprints(fp_id),
  module_ordinal INTEGER NOT NULL,
  factory_function_index INTEGER NOT NULL,
  local_module_id INTEGER,
  dep_count INTEGER, dep_ids TEXT,
  factory_exact_hash BLOB, factory_fuzzy_hash BLOB,
  nested_function_count INTEGER NOT NULL,
  nested_function_indices TEXT,
  function_set_hash BLOB NOT NULL,
  factory_is_baseline INTEGER NOT NULL,
  PRIMARY KEY (fp_id, module_ordinal)
) WITHOUT ROWID;

CREATE TABLE hash_stats (
  kind TEXT NOT NULL,
  hash BLOB NOT NULL,
  distinct_packages INTEGER NOT NULL,
  distinct_fingerprints INTEGER NOT NULL,
  occurrences INTEGER NOT NULL,
  PRIMARY KEY (kind, hash)
) WITHOUT ROWID;

CREATE TABLE import_log (
  source_file TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL,
  fp_id INTEGER,
  status TEXT NOT NULL,
  imported_at TEXT NOT NULL
) WITHOUT ROWID;

-- 2.1 Indexes (the hot path)
CREATE INDEX idx_shape_exact  ON function_shapes (exact_hash);
CREATE INDEX idx_shape_fuzzy  ON function_shapes (fuzzy_hash);
CREATE INDEX idx_shape_sset   ON function_shapes (string_set_hash);
CREATE INDEX idx_shape_opseq  ON function_shapes (opcode_seq_hash) WHERE opcode_seq_hash IS NOT NULL;
CREATE INDEX idx_ff_shape     ON fingerprint_functions (shape_id);
CREATE INDEX idx_mod_factory  ON modules (factory_exact_hash) WHERE factory_exact_hash IS NOT NULL;
CREATE INDEX idx_mod_ffuzzy   ON modules (factory_fuzzy_hash) WHERE factory_fuzzy_hash IS NOT NULL;
CREATE INDEX idx_mod_sethash  ON modules (function_set_hash);
CREATE INDEX idx_fp_hbc       ON fingerprints (hbc_version, pv_id);
CREATE INDEX idx_pv_pkg       ON package_versions (pkg_id);
CREATE INDEX idx_pkg_tier     ON packages (tier, weekly_downloads);

CREATE VIEW sig_files_v AS
SELECT p.name AS package, pv.version AS version, f.hbc_version AS hbcVersion,
       f.source_file AS path, f.total_functions AS totalFunctions,
       f.is_baseline_file AS isBaseline
FROM fingerprints f
JOIN package_versions pv ON pv.pv_id = f.pv_id
JOIN packages p ON p.pkg_id = pv.pkg_id;
