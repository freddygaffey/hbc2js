# 15 — Signature DB: SQLite schema + import + tiered export (sigdb v3)

**Status: SPEC (2026-09-03, Fable). Design only — nothing here is implemented
yet.** Replaces the loose-file signature store (schema 2,
`src/deps/sigdb-types.ts`, one JSON file per `package@version` × HBC version)
with one queryable SQLite database, without changing what the matcher
(`src/deps/match.ts`) *means* by a hit.

Ground truth this spec was designed against, measured on `deb` 2026-09-03:

- `~/hbc2js-bulk/db/` holds **71,302 directory entries = 71,300 top-level
  signature JSON files** (13,773 hbc94 + 13,859 hbc96 + 21,820 hbc98 +
  21,848 hbc99) **+ `index.json` (14 MB) + `_baselines/`** (the per-era
  toolchain/foundation baseline files that `subtractedBaselines` references).
- **28 GB** total; mean file ≈ 400 KB, dominated by per-function rows.
- File shape: `SigDbFile` schema 2 exactly (verified on
  `abbrev@2.0.0__hbc94.json`); `index.json` is `SigDbIndex` schema 1.
- Heavy cross-version redundancy: e.g. `@amplitude/analytics-react-native`
  1.4.10–1.4.14 each carry 852 functions with (per the version-diff pattern
  that motivated fuzzy hashing) largely identical hash tuples. The schema
  below interns function rows for exactly this reason.

Why re-do the store at all: re-fingerprinting 71k package builds is the
expensive, hard-to-repeat step (weeks of `deb` time, D17c). The JSON captured
only what the 2026-08 matcher consumed. This schema **over-captures**: every
field the JSON holds, plus nullable capture-only columns the *new* write path
fills going forward, so the next matcher improvement is an `ALTER TABLE` +
backfill, not a rebuild of the world.

## 0. Where this sits

```
tools/pkgsig/bulk/build-one.mjs ─┐                       ┌─► hbc2js deps match
src/deps/confirm.ts (--confirm) ─┼─► sigdb.sqlite (full) ┼─► tiered export → sigdb-tier<N>.sqlite
future guess-confirm tool ───────┘         ▲             └─► hash_stats (ambiguity, §6.7 DEPS.md)
                 one-shot import of the 71,300 JSON files
```

The three-layer lookup order (project-local → user cache → shared,
`docs/DEPS.md` "Signature DB layering") is unchanged; a layer directory that
contains `sigdb.sqlite` is served from it. Loose schema-2 JSON in a layer
keeps working during the transition (non-goal §8 to delete it).

## 1. Design principles

1. **One row per JSON fact, no lossy import.** Everything in a `SigDbFile`
   lands in a column or child row; a seeded sample must round-trip back to
   deep-equal JSON (§3.4). The original filename and its sha256 are kept.
2. **Intern what repeats.** Per-function tuples repeat massively across
   adjacent versions and across packages (Babel helpers). `function_shapes`
   stores each distinct tuple once; `fingerprint_functions` is a 3-int
   junction. This is the main size lever (§7 target 3).
3. **Hashes are 12-byte BLOBs.** Every hash today is 24 lowercase hex chars
   (96 bits). Stored raw; `hex(h)` in views for humans. Halves index bytes.
4. **Capture-only columns are nullable and cheap.** Legacy imports leave them
   NULL. The write path (§4) fills them from data the fingerprinter already
   has in memory at build time — never a separate pass over the package.
5. **Derived tables are rebuildable, and marked so.** `hash_stats` and the
   rollup columns can be recomputed from base tables at any time
   (`tools/pkgsig/sigdb/rebuild-derived.mjs`, §3.3); they are never the only
   copy of a fact.
6. **Driver: `node:sqlite`** (built into Node ≥ 22.5; no native npm dep, mac
   + Linux). Fallback if `deb`'s Node is older: run the importer under a
   locally-installed Node 22, not a new dependency (§11 Q1).

## 2. Schema (DDL — normative)

The DDL below ships verbatim as `src/deps/sigdb-schema.sql` (implementation
step 1) and is applied with `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
PRAGMA page_size=8192;` on creation.

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
-- rows: schema='hbc2js-sigdb/3', created_at, source_note,
--       slice (''=full | 'tier:<n>' | 'bytes:<B>'), source_db_sha256 (slices)

CREATE TABLE packages (
  pkg_id       INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,  -- full npm name: '@amplitude/analytics-react-native'
  scope        TEXT,                  -- '@amplitude' | NULL
  bare_name    TEXT NOT NULL,         -- 'analytics-react-native'
  -- popularity / tiering (capture-only until §3.3 loader runs)
  tier         INTEGER,               -- 0 baselines+curated starter, 1..3 by rank; NULL unranked
  weekly_downloads      INTEGER,      -- npm registry, point-in-time
  downloads_measured_at TEXT,
  dependents_count      INTEGER,      -- capture-only
  curated_rank INTEGER,               -- position in tools/pkgsig/bulk/packages.json
  curated_reason TEXT                 -- its 'reason' string
);

CREATE TABLE package_versions (
  pv_id        INTEGER PRIMARY KEY,
  pkg_id       INTEGER NOT NULL REFERENCES packages(pkg_id),
  version      TEXT NOT NULL,         -- verbatim npm version string
  semver_major INTEGER, semver_minor INTEGER, semver_patch INTEGER,
  semver_prerelease TEXT,             -- '' if none; 'SR-1975.0' etc. kept verbatim
  published_at TEXT,                  -- capture-only: npm registry publish date
  UNIQUE (pkg_id, version)
);

CREATE TABLE fingerprints (          -- one row per legacy JSON file / per build
  fp_id        INTEGER PRIMARY KEY,
  pv_id        INTEGER NOT NULL REFERENCES package_versions(pv_id),
  hbc_version  INTEGER NOT NULL,
  variant      TEXT NOT NULL DEFAULT '',  -- forward-looking: 'min', 'dev', hermes-flag variants
  source_schema INTEGER NOT NULL,     -- the JSON 'schema' field (2)
  total_functions    INTEGER NOT NULL,
  raw_function_count INTEGER,
  toolchain_baseline INTEGER NOT NULL DEFAULT 0,
  is_baseline_file   INTEGER NOT NULL DEFAULT 0,  -- came from _baselines/
  bulk_build_fix_version INTEGER,
  quarantined  TEXT,                  -- NULL=live; else reason ('unsubtracted', issue #14 class)
  -- provenance, present in today's JSON
  package_sha256 TEXT, metro_version TEXT, react_native_version TEXT,
  hermesc_version INTEGER, hermesc_rn_era TEXT, repo_commit TEXT, built_at TEXT,
  -- provenance, capture-only (new write path fills; NULL on legacy import)
  bundler TEXT,                       -- 'metro' | future bundlers (D18)
  bundler_version TEXT, babel_version TEXT, node_version TEXT,
  minified INTEGER,                   -- 0/1/NULL(unknown)
  builder TEXT,                       -- 'bulk/build-one' | 'confirm' | 'guess-confirm'
  build_host TEXT,
  -- package-level rollups (derived, rebuildable — §3.3)
  sum_instr_count INTEGER, module_count INTEGER,
  non_baseline_module_count INTEGER, distinct_exact_hashes INTEGER,
  -- import bookkeeping
  source_file TEXT, source_sha256 TEXT,  -- NULL for born-in-SQL rows
  imported_at TEXT NOT NULL,
  UNIQUE (pv_id, hbc_version, variant)
);

CREATE TABLE fingerprint_baselines ( -- normalized subtractedBaselines[], order kept
  fp_id INTEGER NOT NULL REFERENCES fingerprints(fp_id),
  ordinal INTEGER NOT NULL,
  baseline_ref TEXT NOT NULL,        -- verbatim: '_baselines/react-foundation@18.2.0__hbc94.json'
  PRIMARY KEY (fp_id, ordinal)
) WITHOUT ROWID;

CREATE TABLE function_shapes (       -- interned: one row per distinct tuple
  shape_id INTEGER PRIMARY KEY,
  exact_hash BLOB NOT NULL, fuzzy_hash BLOB NOT NULL, string_set_hash BLOB NOT NULL,
  name TEXT NOT NULL, param_count INTEGER NOT NULL,
  instr_count INTEGER NOT NULL, string_count INTEGER NOT NULL,
  -- capture-only structural features (NULL on legacy import; §4 fills)
  opcode_seq_hash BLOB,              -- hash of opcode kinds only (operand-blind; more
                                     -- minification/regalloc-resilient than fuzzy_hash)
  bytecode_size INTEGER,             -- function bytecode bytes
  block_count INTEGER, loop_count INTEGER, try_count INTEGER, switch_count INTEGER,
  env_slot_count INTEGER,
  flags INTEGER,                     -- bitfield: 1 async, 2 generator, 4 strict, 8 hasEnv…
  strings_json TEXT,                 -- JSON array of the literal strings behind string_set_hash
  UNIQUE (exact_hash, fuzzy_hash, string_set_hash, name,
          param_count, instr_count, string_count)
);

CREATE TABLE fingerprint_functions ( -- junction; fn_index preserved for round-trip
  fp_id INTEGER NOT NULL REFERENCES fingerprints(fp_id),
  fn_index INTEGER NOT NULL,
  shape_id INTEGER NOT NULL REFERENCES function_shapes(shape_id),
  PRIMARY KEY (fp_id, fn_index)
) WITHOUT ROWID;

CREATE TABLE modules (               -- per-fingerprint, not interned (ids differ per build)
  fp_id INTEGER NOT NULL REFERENCES fingerprints(fp_id),
  module_ordinal INTEGER NOT NULL,   -- position in the JSON 'modules' array
  factory_function_index INTEGER NOT NULL,
  local_module_id INTEGER,           -- nullable in schema 2
  dep_count INTEGER, dep_ids TEXT,   -- dep_ids: JSON int array, NULL if source null
  factory_exact_hash BLOB, factory_fuzzy_hash BLOB,   -- nullable in schema 2
  nested_function_count INTEGER NOT NULL,
  nested_function_indices TEXT,      -- capture-only: JSON int array. Schema 2 deliberately
                                     -- did NOT persist this (sigdb-types.ts) — recomputing it
                                     -- means re-fingerprinting, so persist it from now on.
  function_set_hash BLOB NOT NULL,
  factory_is_baseline INTEGER NOT NULL,
  PRIMARY KEY (fp_id, module_ordinal)
) WITHOUT ROWID;

CREATE TABLE hash_stats (            -- DERIVED, rebuildable; global ambiguity counts
  kind TEXT NOT NULL,                -- 'exact'|'fuzzy'|'stringset'|'factory'|'moduleset'
  hash BLOB NOT NULL,
  distinct_packages INTEGER NOT NULL,      -- distinct non-baseline package names claiming it
  distinct_fingerprints INTEGER NOT NULL,
  occurrences INTEGER NOT NULL,
  PRIMARY KEY (kind, hash)
) WITHOUT ROWID;

CREATE TABLE import_log (            -- §3 resumability
  source_file TEXT PRIMARY KEY,      -- path relative to the JSON db root
  source_sha256 TEXT NOT NULL,
  fp_id INTEGER,
  status TEXT NOT NULL,              -- 'ok' | 'error:<class>'
  imported_at TEXT NOT NULL
) WITHOUT ROWID;
```

### 2.1 Indexes (the hot path — brief item 5)

```sql
-- hash → candidate packages (the matcher's probe; §6)
CREATE INDEX idx_shape_exact  ON function_shapes (exact_hash);
CREATE INDEX idx_shape_fuzzy  ON function_shapes (fuzzy_hash);
CREATE INDEX idx_shape_sset   ON function_shapes (string_set_hash);
CREATE INDEX idx_shape_opseq  ON function_shapes (opcode_seq_hash) WHERE opcode_seq_hash IS NOT NULL;
CREATE INDEX idx_ff_shape     ON fingerprint_functions (shape_id);   -- shape → owning fps
CREATE INDEX idx_mod_factory  ON modules (factory_exact_hash) WHERE factory_exact_hash IS NOT NULL;
CREATE INDEX idx_mod_ffuzzy   ON modules (factory_fuzzy_hash) WHERE factory_fuzzy_hash IS NOT NULL;
CREATE INDEX idx_mod_sethash  ON modules (function_set_hash);
CREATE INDEX idx_fp_hbc       ON fingerprints (hbc_version, pv_id);
CREATE INDEX idx_pv_pkg       ON package_versions (pkg_id);
CREATE INDEX idx_pkg_tier     ON packages (tier, weekly_downloads);
```

`ANALYZE` runs after import and after every export. A convenience view
`sig_files_v` joins packages→versions→fingerprints into the flat
`SigDbIndexEntry` shape so `index.json` becomes a query, not a file.

### 2.2 The capture-only fields, and why each is worth a column now

| field | why over-capture now |
|---|---|
| `opcode_seq_hash` | the fuzzy hash still embeds operand structure; an opcode-kind-only hash is the next resilience rung when a target's register allocation differs (different Metro/minify config — exactly the deps-confirm-tool-IDEAS §4 fidelity question). Computable from bytes the fingerprinter already decodes. |
| `bytecode_size`, `block_count`, `loop_count`, `try_count`, `switch_count`, `env_slot_count`, `flags` | FLIRT-style structural features for scoring *near*-misses and for `--min-instr`-class floors that instr count alone gets wrong; all free at decode time. |
| `strings_json` | today only the string-set *hash* survives, so a single changed string zeroes the signal. The raw set enables partial-overlap scoring and feeds the string-evidence guess stage without re-building the package. Biggest size cost of the capture set — full DB only; always stripped from exports (§5). |
| `nested_function_indices` on modules | schema 2 recomputes it at fingerprint time, i.e. it is *lost* for the 71k built files; persisting it makes module-subtree matching possible without a rebuild. |
| provenance extras (`bundler(_version)`, `babel_version`, `minified`, `node_version`, `builder`, `build_host`) | when a fingerprint mismatches a real bundle, the first question is "built how?"; today that answer is unrecoverable. Also the key for future non-Metro frontends (D18) and minified/dev `variant` rows. |
| `published_at`, `dependents_count`, `weekly_downloads` | version-window heuristics (IDEAS §4) and tiering (§5) need them; point-in-time capture beats re-querying npm later. |
| `semver_*` split columns | range queries ("all 1.5.x") without parsing version strings per row. |

## 3. One-shot import (brief item 2)

`tools/pkgsig/sigdb/import-json.mjs <json-db-dir> <out.sqlite>` — runs on
`deb` against `~/hbc2js-bulk/db/`, also usable on any layer directory.

1. **Enumerate**: list `<dir>/*.json` (excluding `index.json`) and
   `<dir>/_baselines/*.json`; print the total and the per-HBC-version counts
   parsed from filenames. On `deb` today that must print 71,300 + the
   baseline files; the run report records the exact numbers.
2. **Import loop**, resumable + idempotent: for each file, sha256 it; if
   `import_log` has this path with the same sha and `status='ok'`, skip
   (re-running after an interrupt or on an unchanged store is a no-op). Parse
   as `SigDbFile`; refuse any `schema !== 2` (fail the file, not the run).
   Upsert package / package_version (semver split via a small verbatim
   parser, no dependency); insert the fingerprint row with
   `source_file`/`source_sha256`; intern each function through an in-memory
   `tuple→shape_id` LRU backed by `INSERT OR IGNORE` + select; insert module
   and baseline child rows. One transaction per batch of ~200 files (WAL);
   `synchronous=NORMAL` during import only. Parse/constraint failures log
   `status='error:<class>'` and continue — target says this set must end
   empty (§7), but the importer never silently drops.
3. **Derived pass** (`rebuild-derived.mjs`, same code the write path reuses):
   fill the rollup columns, rebuild `hash_stats` (non-baseline package counts
   per hash — precomputing DEPS.md §6.7's ≥20-name ambiguity rule), load
   popularity/tier: curated ranks + reasons from
   `tools/pkgsig/bulk/packages.json` (offline), weekly downloads from the
   npm registry only when run with `--net`. Then `ANALYZE; VACUUM;`.
4. **Completeness check** (`--verify`, also runnable standalone):
   (a) `COUNT(*)` of non-quarantined fingerprints == enumerated file count,
   and per-`hbc_version` counts match the filename-derived counts;
   (b) `import_log` has zero `error:*` rows;
   (c) every `index.json` entry resolves to a fingerprint row whose
   `total_functions` and `isBaseline` agree (the 14 MB index is then
   retired, not migrated);
   (d) **round-trip sample**: seeded 1% of files + every `_baselines` file
   reconstructed from the DB into schema-2 JSON and deep-compared
   (key-order-insensitive) to the source bytes — zero mismatches allowed.

## 4. Write-path change going forward (brief item 3 — design only)

One new shared writer, `src/deps/sigdb-sql.ts`, exporting
`openSigDb(path)`, `insertFingerprint(db, sig: SigDbFile, extras?: CaptureExtras)`,
`quarantine(db, fpId, reason)`, `rebuildDerived(db)`. `CaptureExtras` carries
the §2.2 capture-only fields; the fingerprinter (`src/deps/fingerprint`) is
extended to *return* them (it already decodes every instruction — this is
new outputs, not new passes). Call-site changes:

- **`tools/pkgsig/bulk/build-one.mjs`** — writes via `insertFingerprint`
  into `$HBC2JS_BULK_DB` when that path ends in `.sqlite` (else legacy JSON
  behaviour, unchanged). The bulk runner scripts (`run.sh`,
  `continue-bulk.sh`, `round2b-runner.sh`) need only the env change.
- **`src/deps/confirm.ts`** (the two `writeSignature` calls, ~line 543) —
  project-local and user-cache layers become `<layer-dir>/sigdb.sqlite`;
  `writeSignature` in `src/deps/db.ts` grows the same `.sqlite`-suffix
  dispatch so both callers change minimally.
- **`tools/pkgsig/bulk/baseline-subtract.mjs` / `filter-unsubtracted.mjs`**
  — the quarantine-by-moving-files mechanism (issue #14) becomes
  `quarantine(...)`: a `quarantined` reason column, kept for audit, never
  served. `fetch-db.sh` runs the same check against a fetched `.sqlite`.
- **`tools/pkgsig/bulk/assemble.sh`** and the `index.json` writer in
  `db.ts` — obsolete for SQLite layers; the DB is its own index.
- **Read side** (`src/deps/db.ts` `loadSignatures` + evidence-directed
  candidate loading): a layer directory containing `sigdb.sqlite` is served
  from it; candidate-hash probes become the §6 query. This is
  implementation step 6, deliberately after import parity is proven.

## 5. Tiered export (brief item 4)

`tools/pkgsig/sigdb/export.mjs --db full.sqlite --out slice.sqlite
(--tier <n> | --max-bytes <B>)` — one mechanism for both "ship a small DB
with the npm package" and "user picks a 1 GB / 5 GB / 10 GB download".

- **Column slice**: the output uses the same DDL minus capture-only payload —
  `strings_json`, `nested_function_indices`, structural/provenance
  capture-only columns are NULL/omitted; kept: identity, hashes, counts,
  baseline + quarantine flags, tier. Only what `match.ts` consumes ships.
- **Row slice**: packages ordered by `(tier, -weekly_downloads,
  curated_rank)`; rows 0 (baselines + curated starter set) are always
  included. `--tier n` takes tiers ≤ n; `--max-bytes B` adds packages
  greedily, estimating bytes from row counts × measured per-row averages,
  then `VACUUM`s and, if over B, drops tail packages and re-vacuums
  (≤ 3 iterations; final size must be ≤ B, §7 target 4).
- **`hash_stats` is copied from the FULL DB** for every hash present in the
  slice, never recomputed slice-locally: ambiguity ("≥20 packages claim this
  hash", DEPS.md §6.7) is a global truth — a slice that recounted it would
  resurrect the ljharb/Babel-helper false-confirm storm.
- `meta` records `slice`, `source_db_sha256`, generation time; a sidecar
  `slice-manifest.json` (counts, bytes, sha256) travels with the artifact;
  `fetch-db.sh` learns to fetch + verify `.sqlite.zst` slices.

## 6. The hot lookup

Matcher probe (evidence-directed stage): given the target's hash multiset and
`hbcVersion`, find candidate `package@version`s. Batched, not per-hash:

```sql
CREATE TEMP TABLE probe (hash BLOB PRIMARY KEY);          -- bulk-insert target hashes
SELECT p.name, pv.version, f.fp_id, s.exact_hash, count(*) AS hits
FROM probe
JOIN function_shapes s        ON s.exact_hash = probe.hash
JOIN fingerprint_functions ff ON ff.shape_id = s.shape_id
JOIN fingerprints f           ON f.fp_id = ff.fp_id
     AND f.hbc_version = :hbc AND f.quarantined IS NULL
JOIN package_versions pv      ON pv.pv_id = f.pv_id
JOIN package p                ON p.pkg_id = pv.pkg_id
LEFT JOIN hash_stats hs       ON hs.kind='exact' AND hs.hash = s.exact_hash
WHERE coalesce(hs.distinct_packages, 1) < 20              -- ambiguity floor, precomputed
GROUP BY f.fp_id, s.exact_hash;
```

Analogous probes for `fuzzy`, `string_set`, module `factory_exact` /
`function_set` hashes. All are single index-driven joins — no file
enumeration, no JSON parsing, and the ambiguity rule costs one indexed
`LEFT JOIN` instead of loading the whole DB to count claimants.

## 7. Decision-8 quadruple (metric / target / method / held-out)

| # | metric | target | measured how |
|---|---|---|---|
| 1 | **Import completeness** | 100% of the enumerated store — 71,300 top-level signature files (measured 2026-09-03; the importer re-counts) + all `_baselines/*.json`; **0 dropped**, 0 `error:*` rows; round-trip sample (§3.4d, seed 1, 1% + all baselines) 0 mismatches; every `index.json` entry reconciled | `import-json.mjs --verify` printout on `deb`, pasted into the landing report |
| 2 | **Match-lookup latency** | full 43,384-hash probe set (NSW-scale, the DEPS.md benchmark bundle) against the FULL db: ≤ 2 s wall total for all five probe kinds, best-of-3, on `deb`; single-package candidate probe median ≤ 5 ms | `tools/pkgsig/sigdb/bench.mjs` replaying recorded probe sets; compare against the measured JSON-path numbers in DEPS.md (162 ms evidence-directed / 4.4 s exhaustive synthetic) |
| 3 | **DB size** | full DB ≤ 40% of the JSON store's bytes (≤ 11.2 GB vs 28 GB) after VACUUM+ANALYZE, capture-only columns included | `du -sh` both, on `deb` |
| 4 | **Tiered-export bound** | `--max-bytes 1G` slice containing ≥ the top-1,000 packages by tier/downloads, final file ≤ 1 GiB (hard; the export iterates until under) | export run + `slice-manifest.json` in the report |
| H | **Held-out check** | with the SQLite layer substituted for the JSON layers, `hbc2js deps --json` on the real `au.gov.nsw.service.apk` bundle produces an identical DepsReport (same confirmed/guessed sets, same tiers) — a bundle never used to tune this schema; plus one more local-corpus app spot-check, hash-recorded, bundle never in the repo | diff of the two reports, in the landing report |

## 8. Non-goals (v1)

- **Changing matcher semantics.** Same hashes, same tiers, same ambiguity
  threshold; SQLite changes where facts live, not what they mean. (The
  capture-only columns *enable* future scoring work; using them is future
  specs' business.)
- **Deleting the JSON store or JSON layer support.** The 28 GB store on
  `deb` stays until §7 targets 1 and H are green; loose-JSON layers keep
  loading indefinitely (project-local sigdbs are committed in user repos).
- **Populating popularity for all of npm.** Only packages present in the DB
  get download counts, and only when the loader runs with `--net`.
- **A server / remote-query DB.** Distribution stays "download a file"
  (`fetch-db.sh`); SQLite over HTTP-range tricks are explicitly out.
- **Full-text search over `strings_json`** — capture now, FTS5 later if a
  consumer materialises.
- **Backfilling capture-only columns for the 71k legacy rows** — needs
  re-fingerprinting; the schema makes it an UPDATE keyed by `fp_id` whenever
  a rebuild happens for other reasons.

## 9. Acceptance tests

Pre-implementation tests (the spec agent's, to be materialised verbatim as
implementation step 0 in `tests/sigdb/`; fixture = the real
`abbrev@2.0.0__hbc94.json` captured 2026-09-03, committed as
`tests/fixtures/sigdb/abbrev@2.0.0__hbc94.json` — it is our own build output
of an ISC-licensed package's *fingerprints*, no third-party code):

- **A1 `schema.test.ts`** — applying `src/deps/sigdb-schema.sql` to a fresh
  DB succeeds; `meta.schema='hbc2js-sigdb/3'`; every §2.1 index exists
  (query `sqlite_master`); re-applying is rejected (no silent re-init).
- **A2 `roundtrip.test.ts`** — `insertFingerprint` on the abbrev fixture,
  then reconstruct schema-2 JSON from the DB: deep-equal to the fixture
  (key-order-insensitive), including `subtractedBaselines` order, null
  `provenance` fields, and `factoryIsBaseline`. Hashes stored as 12-byte
  BLOBs (assert `typeof` and length via `length(exact_hash)=12`).
- **A3 `idempotent.test.ts`** — importing the same file twice (same sha)
  yields one fingerprint row and an `import_log` skip; importing a *changed*
  file with the same name errors rather than silently replacing.

Specified precisely, written at their implementation step:

- **A4 (step 2)** — interning: two synthetic fingerprints sharing 3 of 4
  function tuples produce exactly 5 `function_shapes` rows and 8 junction
  rows; round-trip of both still exact.
- **A5 (step 3)** — completeness checker: a directory of N synthetic files
  with 1 deliberately corrupt → verify fails, names the file, exits non-zero;
  after fixing, passes with N/N and 0 errors.
- **A6 (step 4)** — `hash_stats`: synthetic 21-package shared hash is
  excluded by the §6 probe; a 7-package hash is not (mirrors DEPS.md §6.7's
  measured 7-name legitimate chain).
- **A7 (step 5)** — export: slice contains no non-NULL `strings_json` /
  capture-only provenance; tier-0 baselines always present;
  `--max-bytes` bound respected on a synthetic oversized input;
  `hash_stats` rows in the slice equal the full DB's values.
- **A8 (step 6)** — layer dispatch: a layer dir with `sigdb.sqlite` is
  served from it; `--json` DepsReport on a construct-fixture bundle equals
  the JSON-layer report byte-for-byte.

## 10. Implementation plan (lean-agent-sized, ordered; reuse column binding)

| step | delivers | reuses | new |
|---|---|---|---|
| 0 | materialise A1–A3 + abbrev fixture; red | this spec §2/§9 | `tests/sigdb/*` |
| 1 | `src/deps/sigdb-schema.sql` + `src/deps/sigdb-sql.ts` (open/insert/quarantine/round-trip read); A1–A2 green | `sigdb-types.ts` | writer module |
| 2 | shape interning + import batching; A3–A4 green | step 1 | LRU + txn loop |
| 3 | `tools/pkgsig/sigdb/import-json.mjs` + `--verify`; run on `deb`; §7 target 1 + 3 measured | steps 1–2, `filter-unsubtracted` logic | importer |
| 4 | `rebuild-derived.mjs` (rollups, `hash_stats`, popularity/tier loader); A6 | `packages.json`, `candidates.json` | derived pass |
| 5 | `export.mjs` + `bench.mjs`; §7 targets 2 + 4 measured; A7 | steps 1–4 | export + bench |
| 6 | write-path + read-path dispatch (§4): `build-one.mjs`, `confirm.ts`, `db.ts` layer detection, `fetch-db.sh` `.sqlite.zst`; A8; §7 H measured on NSW | `src/deps/db.ts`, DEPS.md benchmarks | dispatch |

Steps 3–5 run on `deb`; each step is one commit with its tests. The JSON
store is untouched throughout.

## 11. Open questions for the reviewer

1. **Driver**: `node:sqlite` needs Node ≥ 22.5. Is that acceptable as a
   floor for the *tools* (importer runs on `deb`; the read path ships in the
   npm package)? If not, `better-sqlite3` is the fallback at the cost of a
   native dependency — who decides?
2. **`strings_json` cost**: capturing raw string sets going forward could
   dominate future DB growth (it is why the export strips it). Cap per
   function (e.g. first 64 strings + overflow flag), or capture all?
3. **Interning tuple**: `name` is inside the uniqueness tuple (schema-2
   fidelity for round-trip). Interning *ignoring* name would dedupe more
   (minified names differ across builds) at the cost of a name side-table.
   Worth it now or after target 3 is measured?
4. **`variant` semantics**: proposed as free text (`''`/`min`/`dev`). Should
   the matcher *prefer* a variant matching the target bundle's detected
   minification, or is that future-spec scoring business (my assumption)?
5. **Ambiguity threshold location**: §6 bakes `< 20` into the probe via
   `hash_stats`. Keep the constant in `match.ts` and pass it as a query
   parameter instead (single source of truth)?

## 12. Review responses

*(placeholder — filled by the reviewer gate before implementation starts)*
