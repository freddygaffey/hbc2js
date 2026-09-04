-- src/projdb/schema.sql — hbc2js project DB v1 (docs/specs/16-project-db.md §2,
-- normative DDL). Applied verbatim to a fresh `project.hbcproj` by
-- `src/projdb/db.ts`'s `openProjectDb`, inside one transaction, together
-- with the identity pragmas from §1.1 (`application_id`, `user_version`,
-- `journal_mode`, `foreign_keys`, `page_size`) which are NOT part of this
-- file (they must be set before/around DDL application, not embedded in it —
-- mirrors `src/deps/sigdb-sql.ts`'s `openSigDb` convention).
--
-- Four strata (§2 table): derived index (`ix_*`, rebuilt wholesale, no
-- triggers), annotations (`revisions` + `d_*` detail, append-only,
-- trigger-enforced), history (`log`, append-only, trigger-enforced), and
-- identity (`meta`, key-value).
--
-- §1.1 identity pragmas are set here (not only by db.ts) so that applying
-- this file alone — as A1 (§7) does, with plain `db.exec(ddl)` and no other
-- setup — is sufficient to make `PRAGMA application_id`/`user_version`
-- readable immediately. `db.ts` still owns `page_size`/`journal_mode`/
-- `foreign_keys`, which must be set outside a fresh file's first
-- transaction.

PRAGMA application_id=1212306000; -- 0x48425250, ASCII "HBRP" (§1.1)
PRAGMA user_version=1;             -- major schema version (§1.1)

-- ===========================================================================
-- 2.1 meta — identity and staleness root
-- ===========================================================================

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
-- rows: schema='hbc2js-proj/1'; created_at;
--   bundle_sha256, bundle_bytes, hbc_version, function_count   (spec 10 §1.2 bundle block)
--   producer_json      (exact PassPipelineOptions + hbc2js version + git, spec 10 §1.2)
--   index_gen          (integer; bumped by every index rebuild, §5.2)
--   index_built_for    (sha256 over bundle_sha256+producer_json the CURRENT ix_* rows derive from)
--   render_hash        (spec 10 §1.2; the render ix_ranges rows describe)
--   host_globals_sha   (sha256 of the in-repo curated list used at build, spec 10 §2.5)

-- ===========================================================================
-- 2.2 log — the change history
-- ===========================================================================

CREATE TABLE log (
  seq     INTEGER PRIMARY KEY,          -- monotonic; the project's history order
  ts      TEXT NOT NULL,                -- iso
  actor_source TEXT NOT NULL CHECK (actor_source IN ('human','llm','tool')),
  actor_who    TEXT NOT NULL,           -- spec 11 §2.1 prov.who
  actor_run    TEXT,                    -- prov.run
  op      TEXT NOT NULL,                -- 'init'|'import'|'rebuild-index'|'annotate'|
                                        -- 'revert'|'merge'|'export'|'render'
  rid     INTEGER REFERENCES revisions(rid),  -- for op='annotate'/'revert'
  gen     INTEGER,                      -- for op='rebuild-index': the new index_gen
  detail  TEXT                          -- small JSON: counts, source hashes, export path…
);

-- ===========================================================================
-- 2.3 Annotation stratum — envelope + per-kind detail
-- ===========================================================================

CREATE TABLE revisions (
  rid       INTEGER PRIMARY KEY,        -- store-local monotonic (spec 11 rid)
  kind      TEXT NOT NULL CHECK (kind IN
              ('name','comment','tag','bookmark','finding','status','conflict')),
  target    TEXT NOT NULL,              -- bindingKey | 'fn:N' | 'sid:N' | 'mod:N' (id.ts vocabulary)
  slot      TEXT NOT NULL,              -- the supersession slot key: kind+target[+tag] (spec 11 §2.1)
  prov_source TEXT NOT NULL CHECK (prov_source IN ('human','llm','tool')),
  prov_who  TEXT NOT NULL,
  prov_run  TEXT,
  ts        TEXT NOT NULL,
  supersedes  INTEGER REFERENCES revisions(rid),  -- prior head of the slot, or NULL
  reactivates INTEGER REFERENCES revisions(rid),  -- revert: payload is that rid's (else NULL)
  cleared   INTEGER NOT NULL DEFAULT 0, -- 1 = this head empties the slot (revert-to-nothing)
  ctx_name  TEXT, ctx_loc TEXT, ctx_owner TEXT,   -- spec 11 §2.1 ctx snapshot (orphan context)
  legacy_rid TEXT                       -- the JSONL rid this row was imported from (§4.3), else NULL
);
CREATE INDEX revisions_slot ON revisions(slot, rid);
CREATE INDEX revisions_target ON revisions(target);

CREATE TABLE d_names     (rid INTEGER PRIMARY KEY REFERENCES revisions(rid),
                          name TEXT NOT NULL);
CREATE TABLE d_comments  (rid INTEGER PRIMARY KEY REFERENCES revisions(rid),
                          body TEXT NOT NULL, range_line INTEGER, range_col INTEGER);
CREATE TABLE d_tags      (rid INTEGER PRIMARY KEY REFERENCES revisions(rid),
                          tag TEXT NOT NULL, note TEXT);   -- taxonomy: spec 11 §1.3, unchanged
CREATE TABLE d_bookmarks (rid INTEGER PRIMARY KEY REFERENCES revisions(rid),
                          label TEXT);
CREATE TABLE d_findings  (rid INTEGER PRIMARY KEY REFERENCES revisions(rid),
                          finding_no INTEGER NOT NULL,     -- stable human-facing '#12'
                          severity TEXT NOT NULL, status TEXT NOT NULL, claim TEXT NOT NULL);
CREATE TABLE d_evidence  (rid INTEGER NOT NULL REFERENCES revisions(rid),
                          ord INTEGER NOT NULL, ref TEXT NOT NULL, role TEXT NOT NULL,
                          PRIMARY KEY (rid, ord));         -- spec 11 §1.5 evidence refs
CREATE TABLE d_conflicts (rid INTEGER PRIMARY KEY REFERENCES revisions(rid),
                          rid_a INTEGER NOT NULL, rid_b INTEGER NOT NULL);  -- spec 11 §2.3

-- ===========================================================================
-- 2.4 Derived index stratum — spec 10 §2, one table per JSONL kind
-- ===========================================================================

CREATE TABLE ix_functions (fn INTEGER PRIMARY KEY, name TEXT, params INTEGER NOT NULL,
  module INTEGER, parent INTEGER, kind TEXT NOT NULL, offset INTEGER NOT NULL,
  size INTEGER NOT NULL);                                     -- §2.1 there
CREATE TABLE ix_calls (caller INTEGER NOT NULL, site INTEGER NOT NULL,
  callee TEXT NOT NULL,           -- 'NN' | 'g:…' | 'm:…' | 'b:…' | '?'  (verbatim vocabulary)
  kind TEXT NOT NULL, via TEXT, why TEXT,
  PRIMARY KEY (caller, site),
  CHECK (callee != '?' OR why IS NOT NULL));                  -- '?' always carries why
CREATE INDEX ix_calls_callee ON ix_calls(callee);             -- who-calls inversion
CREATE TABLE ix_strings (sid INTEGER PRIMARY KEY, v TEXT,     -- NULL v when >4KB:
  len INTEGER NOT NULL, sha256 TEXT, head TEXT);              -- head+sha stored (spec 10 §2.3a)
CREATE TABLE ix_string_uses (sid INTEGER NOT NULL, fn INTEGER NOT NULL,
  role TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (sid, fn, role));
CREATE INDEX ix_string_uses_fn ON ix_string_uses(fn);
CREATE TABLE ix_globals (g TEXT NOT NULL, fn INTEGER NOT NULL,
  access TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (g, fn, access));
CREATE TABLE ix_native (fn INTEGER NOT NULL, surface TEXT NOT NULL,
  name TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (fn, surface, name));
CREATE TABLE ix_modules (id INTEGER PRIMARY KEY, file TEXT NOT NULL,
  factory_fn INTEGER, segment INTEGER);
CREATE TABLE ix_module_deps (id INTEGER NOT NULL, ord INTEGER NOT NULL,
  dep INTEGER NOT NULL, PRIMARY KEY (id, ord));
CREATE TABLE ix_ranges (fn INTEGER PRIMARY KEY, file TEXT NOT NULL,
  line_start INTEGER NOT NULL, line_end INTEGER NOT NULL);
  -- render-coupled: valid only while meta.render_hash matches the live render (§5.2)

-- ===========================================================================
-- 2.5 Append-only + read-only enforcement (triggers)
-- ===========================================================================

CREATE TRIGGER log_no_update  BEFORE UPDATE ON log
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: log'); END;
CREATE TRIGGER log_no_delete  BEFORE DELETE ON log
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: log'); END;

CREATE TRIGGER revisions_no_update  BEFORE UPDATE ON revisions
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: revisions'); END;
CREATE TRIGGER revisions_no_delete  BEFORE DELETE ON revisions
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: revisions'); END;

CREATE TRIGGER d_names_no_update  BEFORE UPDATE ON d_names
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: d_names'); END;
CREATE TRIGGER d_names_no_delete  BEFORE DELETE ON d_names
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: d_names'); END;

CREATE TRIGGER d_comments_no_update  BEFORE UPDATE ON d_comments
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: d_comments'); END;
CREATE TRIGGER d_comments_no_delete  BEFORE DELETE ON d_comments
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: d_comments'); END;

CREATE TRIGGER d_tags_no_update  BEFORE UPDATE ON d_tags
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: d_tags'); END;
CREATE TRIGGER d_tags_no_delete  BEFORE DELETE ON d_tags
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: d_tags'); END;

CREATE TRIGGER d_bookmarks_no_update  BEFORE UPDATE ON d_bookmarks
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: d_bookmarks'); END;
CREATE TRIGGER d_bookmarks_no_delete  BEFORE DELETE ON d_bookmarks
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: d_bookmarks'); END;

CREATE TRIGGER d_findings_no_update  BEFORE UPDATE ON d_findings
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: d_findings'); END;
CREATE TRIGGER d_findings_no_delete  BEFORE DELETE ON d_findings
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: d_findings'); END;

CREATE TRIGGER d_evidence_no_update  BEFORE UPDATE ON d_evidence
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: d_evidence'); END;
CREATE TRIGGER d_evidence_no_delete  BEFORE DELETE ON d_evidence
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: d_evidence'); END;

CREATE TRIGGER d_conflicts_no_update  BEFORE UPDATE ON d_conflicts
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: d_conflicts'); END;
CREATE TRIGGER d_conflicts_no_delete  BEFORE DELETE ON d_conflicts
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: d_conflicts'); END;

-- ===========================================================================
-- 2.3 (view) v_active — the derived active-slot notion (§2.3)
--
-- "the head of a slot is its max rid. The slot's active payload is: nothing
-- if head.cleared=1; else head.reactivates's detail row if set; else head's
-- own detail row." One row per non-empty slot: head rid, payload rid, kind,
-- target. NOTE (implementer, transcribing a described rule, not a literal
-- snippet in the spec): the payload rid resolves via `reactivates` when set;
-- readers join the appropriate `d_*` table on `payload_rid`.
-- ===========================================================================

CREATE VIEW v_active AS
  SELECT h.rid AS head_rid, h.kind AS kind, h.target AS target,
         COALESCE(h.reactivates, h.rid) AS payload_rid
    FROM revisions h
   WHERE h.cleared = 0
     AND h.rid = (SELECT MAX(rid) FROM revisions WHERE slot = h.slot);

-- ===========================================================================
-- 3.1 v_json_* — one JSON text per row, JSONL row shape + sort order
--
-- v_json_calls is the ONLY view given verbatim in the spec text (§3.1); the
-- rest are described as "likewise v_json_functions, v_json_strings,
-- v_json_string_uses, v_json_globals, v_json_native, v_json_modules,
-- v_json_ranges, and for annotations v_json_names / v_json_tags /
-- v_json_comments / v_json_bookmarks / v_json_findings" WITHOUT their own
-- literal SQL. The definitions below are transcribed by direct analogy to
-- v_json_calls (JSON key per column, same name, ORDER BY the table's primary
-- key) for the ix_* views, and per the §2.1 spec-11 envelope (+ §2.3's
-- legacy_rid substitution note) for the annotation views. `v_json_module_deps`
-- is added for completeness (ix_module_deps is its own JSONL-kind table per
-- §2.4's header) though it is not named in the spec's "likewise" list. THIS
-- IS THE GENUINE DDL AMBIGUITY flagged in the landing report — field
-- order/NULL-elision for every view but v_json_calls is not pinned by prose,
-- only by A6 (§7, step 5) against a real spec-10 export, not yet
-- implemented. Revisit these definitions against A6 in step 5.
-- ===========================================================================

CREATE VIEW v_json_calls AS
  SELECT json_object('caller',caller,'site',site,
           'callee', CASE WHEN callee GLOB '[0-9]*' THEN json(callee) ELSE json_quote(callee) END,
           'kind',kind,'via',via,'why',why) AS j,
         caller, site FROM ix_calls ORDER BY caller, site;

CREATE VIEW v_json_functions AS
  SELECT json_object('fn',fn,'name',name,'params',params,'module',module,
           'parent',parent,'kind',kind,'offset',offset,'size',size) AS j,
         fn FROM ix_functions ORDER BY fn;

CREATE VIEW v_json_strings AS
  SELECT json_object('sid',sid,'v',v,'len',len,'sha256',sha256,'head',head) AS j,
         sid FROM ix_strings ORDER BY sid;

CREATE VIEW v_json_string_uses AS
  SELECT json_object('sid',sid,'fn',fn,'role',role,'n',n) AS j,
         sid, fn, role FROM ix_string_uses ORDER BY sid, fn, role;

CREATE VIEW v_json_globals AS
  SELECT json_object('g',g,'fn',fn,'access',access,'n',n) AS j,
         g, fn, access FROM ix_globals ORDER BY g, fn, access;

CREATE VIEW v_json_native AS
  SELECT json_object('fn',fn,'surface',surface,'name',name,'n',n) AS j,
         fn, surface, name FROM ix_native ORDER BY fn, surface, name;

CREATE VIEW v_json_modules AS
  SELECT json_object('id',id,'file',file,'factory_fn',factory_fn,'segment',segment) AS j,
         id FROM ix_modules ORDER BY id;

CREATE VIEW v_json_module_deps AS
  SELECT json_object('id',id,'ord',ord,'dep',dep) AS j,
         id, ord FROM ix_module_deps ORDER BY id, ord;

CREATE VIEW v_json_ranges AS
  SELECT json_object('fn',fn,'file',file,'line_start',line_start,'line_end',line_end) AS j,
         fn FROM ix_ranges ORDER BY fn;

CREATE VIEW v_json_names AS
  SELECT json_object(
           'rid', COALESCE(r.legacy_rid, CAST(r.rid AS TEXT)),
           'kind', r.kind, 'target', r.target,
           'prov', json_object('source', r.prov_source, 'who', r.prov_who, 'run', r.prov_run),
           'ts', r.ts,
           'supersedes', (SELECT COALESCE(s.legacy_rid, CAST(s.rid AS TEXT))
                             FROM revisions s WHERE s.rid = r.supersedes),
           'active', EXISTS (SELECT 1 FROM v_active a WHERE a.head_rid = r.rid),
           'ctx', json_object('name', r.ctx_name, 'loc', r.ctx_loc, 'ownerFn', r.ctx_owner),
           'name', d.name) AS j,
         r.rid FROM revisions r JOIN d_names d ON d.rid = r.rid
   WHERE r.kind = 'name' ORDER BY r.rid;

CREATE VIEW v_json_comments AS
  SELECT json_object(
           'rid', COALESCE(r.legacy_rid, CAST(r.rid AS TEXT)),
           'kind', r.kind, 'target', r.target,
           'prov', json_object('source', r.prov_source, 'who', r.prov_who, 'run', r.prov_run),
           'ts', r.ts,
           'supersedes', (SELECT COALESCE(s.legacy_rid, CAST(s.rid AS TEXT))
                             FROM revisions s WHERE s.rid = r.supersedes),
           'active', EXISTS (SELECT 1 FROM v_active a WHERE a.head_rid = r.rid),
           'ctx', json_object('name', r.ctx_name, 'loc', r.ctx_loc, 'ownerFn', r.ctx_owner),
           'body', d.body,
           'range', CASE WHEN d.range_line IS NULL THEN NULL
                         ELSE json_object('line', d.range_line, 'col', d.range_col) END) AS j,
         r.rid FROM revisions r JOIN d_comments d ON d.rid = r.rid
   WHERE r.kind = 'comment' ORDER BY r.rid;

CREATE VIEW v_json_tags AS
  SELECT json_object(
           'rid', COALESCE(r.legacy_rid, CAST(r.rid AS TEXT)),
           'kind', r.kind, 'target', r.target,
           'prov', json_object('source', r.prov_source, 'who', r.prov_who, 'run', r.prov_run),
           'ts', r.ts,
           'supersedes', (SELECT COALESCE(s.legacy_rid, CAST(s.rid AS TEXT))
                             FROM revisions s WHERE s.rid = r.supersedes),
           'active', EXISTS (SELECT 1 FROM v_active a WHERE a.head_rid = r.rid),
           'ctx', json_object('name', r.ctx_name, 'loc', r.ctx_loc, 'ownerFn', r.ctx_owner),
           'tag', d.tag, 'note', d.note) AS j,
         r.rid FROM revisions r JOIN d_tags d ON d.rid = r.rid
   WHERE r.kind = 'tag' ORDER BY r.rid;

CREATE VIEW v_json_bookmarks AS
  SELECT json_object(
           'rid', COALESCE(r.legacy_rid, CAST(r.rid AS TEXT)),
           'kind', r.kind, 'target', r.target,
           'prov', json_object('source', r.prov_source, 'who', r.prov_who, 'run', r.prov_run),
           'ts', r.ts,
           'supersedes', (SELECT COALESCE(s.legacy_rid, CAST(s.rid AS TEXT))
                             FROM revisions s WHERE s.rid = r.supersedes),
           'active', EXISTS (SELECT 1 FROM v_active a WHERE a.head_rid = r.rid),
           'ctx', json_object('name', r.ctx_name, 'loc', r.ctx_loc, 'ownerFn', r.ctx_owner),
           'label', d.label) AS j,
         r.rid FROM revisions r JOIN d_bookmarks d ON d.rid = r.rid
   WHERE r.kind = 'bookmark' ORDER BY r.rid;

CREATE VIEW v_json_findings AS
  SELECT json_object(
           'rid', COALESCE(r.legacy_rid, CAST(r.rid AS TEXT)),
           'kind', r.kind, 'target', r.target,
           'prov', json_object('source', r.prov_source, 'who', r.prov_who, 'run', r.prov_run),
           'ts', r.ts,
           'supersedes', (SELECT COALESCE(s.legacy_rid, CAST(s.rid AS TEXT))
                             FROM revisions s WHERE s.rid = r.supersedes),
           'active', EXISTS (SELECT 1 FROM v_active a WHERE a.head_rid = r.rid),
           'ctx', json_object('name', r.ctx_name, 'loc', r.ctx_loc, 'ownerFn', r.ctx_owner),
           'finding_no', d.finding_no, 'severity', d.severity,
           'status', d.status, 'claim', d.claim) AS j,
         r.rid FROM revisions r JOIN d_findings d ON d.rid = r.rid
   WHERE r.kind = 'finding' ORDER BY r.rid;

-- ===========================================================================
-- MIGRATION 2 — worker/session operational stratum (docs/specs/23-ui-workers.md
-- §3/§4). ADDITIVE ONLY. Everything between the two markers below is (a)
-- applied to a fresh DB as part of this file and (b) re-applied on its own by
-- `db.ts`'s `migrateProjectDb` to a minor-1 DB, so the block must stay
-- idempotent (`IF NOT EXISTS` on every object) and must never alter an
-- existing v1 object.
--
-- Boundary rule (spec 18 §4, restated in spec 23 §4.1): these tables are
-- OPERATIONAL state, not authoritative analysis — they are never exported to
-- `analysis/` shards and never enter the hash-chained `log/`. `cache.db` is
-- disposable (spec 18 §2); losing a job queue loses nothing authoritative,
-- because a job's *output* is an annotation written through the normal write
-- path. `sessions`/`jobs`/`claims` are therefore mutable (no append-only
-- triggers, unlike `log`/`revisions`); `worker_events` is the append-only
-- change feed and DOES carry the trigger pair.
-- >>> MIGRATION 2 >>>
CREATE TABLE IF NOT EXISTS sessions (
  id        TEXT PRIMARY KEY,          -- caller-supplied or content-derived id
  kind      TEXT NOT NULL CHECK (kind IN ('human','worker','external')),
  who       TEXT NOT NULL,             -- email | 'worker:<jobKind>' | mcp client id
  opened_at TEXT NOT NULL,             -- iso
  last_seen TEXT NOT NULL,             -- iso; heartbeat (spec 23 §3)
  closed_at TEXT,                      -- iso, or NULL while open
  meta      TEXT                       -- small JSON
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sessions_live ON sessions(closed_at, last_seen);

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,    -- content hash (spec 23 §1)
  kind            TEXT NOT NULL,       -- 'explain-fn' | 'suggest-name' | … (§1)
  input           TEXT NOT NULL,       -- JSON
  status          TEXT NOT NULL CHECK (status IN
                    ('queued','running','done','failed','cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_by      TEXT REFERENCES sessions(id),
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  progress_done   INTEGER NOT NULL DEFAULT 0,
  progress_total  INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,   -- retry policy (§2.4)
  result          TEXT,                -- JSON: {tier,proposal,writes:[…]}
  error           TEXT,
  cost            TEXT                 -- JSON: {maxTokens,maxSeconds,tokensIn,tokensOut}
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at, id);

CREATE TABLE IF NOT EXISTS claims (
  target      TEXT PRIMARY KEY,        -- 'fn:N' | 'mod:N' (id.ts vocabulary)
  session     TEXT NOT NULL REFERENCES sessions(id),
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL            -- advisory TTL (§3)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS worker_events (
  seq     INTEGER PRIMARY KEY,         -- monotonic; the UI tails this
  ts      TEXT NOT NULL,
  type    TEXT NOT NULL CHECK (type IN
            ('session.open','session.close',
             'job.queued','job.started','job.progress','job.done','job.failed','job.cancelled',
             'claim.acquire','claim.release')),
  session TEXT,
  job     TEXT,
  target  TEXT,
  detail  TEXT                         -- small JSON
);
CREATE TRIGGER IF NOT EXISTS worker_events_no_update BEFORE UPDATE ON worker_events
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: worker_events'); END;
CREATE TRIGGER IF NOT EXISTS worker_events_no_delete BEFORE DELETE ON worker_events
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: worker_events'); END;
-- <<< MIGRATION 2 <<<

-- ===========================================================================
-- MIGRATION 3 — provenance tier (docs/specs/17-mcp-harness.md §15; the spec 23
-- §4 "known gap" follow-up: `set_name`/`add_comment`/`add_tag`/
-- `record_finding` gain a `tier: "suggested"|"accepted"` so an AI proposal can
-- be written WITHOUT occupying the truth slot). Same discipline as MIGRATION
-- 2: a NEW table, never an ALTER on an existing v1 object — this build's
-- sqlite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (checked; syntax
-- error), so an in-place column add cannot be made idempotent the way
-- `CREATE TABLE IF NOT EXISTS` already is, and idempotence is a hard
-- requirement here (`tests/workers/storage.test.ts`'s "migration block is
-- idempotent" replays `migrationSql(SCHEMA_MINOR)` twice against a live DB).
-- A side table sidesteps the limitation entirely.
--
-- One row per `revisions.rid` that named a tier explicitly; `rid`s with no
-- row here (every pre-this-round write, and every caller that still omits
-- `tier`) read as `'accepted'` — `src/projdb/revision-store.ts`'s `readTier`
-- COALESCEs, so this table needs no backfill and an older DB migrates with
-- zero rows in it, all its existing names/comments/tags/findings unchanged.
-- >>> MIGRATION 3 >>>
CREATE TABLE IF NOT EXISTS revision_tier (
  rid  INTEGER PRIMARY KEY REFERENCES revisions(rid),
  tier TEXT NOT NULL CHECK (tier IN ('suggested','accepted'))
);
-- <<< MIGRATION 3 <<<

-- ===========================================================================
-- MIGRATION 4 — segregation cache (docs/UI.md's `/api/segregation` route,
-- `src/ui-server/segregation.ts`, `src/projdb/seg-cache.ts`). Persists the
-- name-recovery tree so a ui-server restart serves it in sub-millisecond
-- time instead of re-running `segregateSplitTree` (measured 5 s isolated,
-- 37-70 s loaded on a 4.5k-module bundle) on every single process start.
-- Same discipline as MIGRATION 2/3: new tables only, `IF NOT EXISTS` on
-- every object, never an ALTER on an existing v1/v2/v3 object.
--
-- Boundary rule (spec 18 §4, restated at MIGRATION 2 above): this is
-- OPERATIONAL cache state, not authoritative analysis — `seg_modules`/
-- `seg_meta` are never exported to `analysis/` shards and never enter the
-- hash-chained `log/`. It is disposable exactly like `cache.db` (spec 18
-- §2): losing it loses a few seconds of recompute, nothing authoritative,
-- and `seg-cache.ts` treats a missing table (pre-migration DB, or a
-- `--split` artifact with no DB at all) or an invalidation-key mismatch
-- exactly like a cold cache — recompute and overwrite, never an error.
--
-- `seg_meta.value('invalidation_key')` is a hash over the module tree the
-- cached rows were computed from (`seg-cache.ts`'s `moduleTreeKey`) plus,
-- once the deps-aware pass has run, an identity for that pass's report —
-- so a cache hit requires BOTH "the module files haven't changed" and (for
-- the deps-applied row set) "the same deps answer". `deps_applied` mirrors
-- `SegregationResult.depsApplied` so a restart can serve the deps-aware
-- answer immediately without re-running `McpResources.depsReport()`.
-- >>> MIGRATION 4 >>>
CREATE TABLE IF NOT EXISTS seg_modules (
  id              INTEGER PRIMARY KEY,   -- module id (SegregationRow.id)
  path            TEXT NOT NULL,         -- SegregationRow.path
  bucket          TEXT NOT NULL,         -- SegregationRow.bucket
  package         TEXT,                  -- SegregationRow.package
  name_signal     TEXT,                  -- SegregationRow.nameSignal
  name_confidence REAL                   -- SegregationRow.nameConfidence
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS seg_meta (
  key   TEXT PRIMARY KEY,                -- 'invalidation_key' | 'deps_applied'
  value TEXT NOT NULL
) WITHOUT ROWID;
-- <<< MIGRATION 4 <<<
