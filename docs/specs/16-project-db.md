# 16 — The project database: one SQLite file as the analysis surface (P2.2b)

**Status: SPEC (2026-09-03, Fable). Design only — nothing here is implemented
yet.** Consolidates the artifact index (spec 10's `index/*.jsonl`) and the
project store (spec 11's `project/*.jsonl` + the Design-D overlay) into **one
versioned SQLite database per analysed bundle**, created by `hbc2js init`.
The database becomes THE storage; JSON/JSONL becomes a **generated view**
(query → JSON), never the storage itself. It is versioned and logged like
git — an append-only change history, auditable and queryable across sessions —
and it is the surface the analysis loop interfaces through.

Reading list: `docs/specs/10-artifact-format.md` §2 (index content — the row
vocabulary reused verbatim), §3 (query verbs + token bounds), §4 (truth);
`docs/specs/11-project-store.md` §1–§2 (record types, envelope, slot/rid/
supersede), §3 (verbs + bounds), §4 (truth); `docs/specs/15-sigdb-schema.md`
§1 (the SQLite design principles this spec inherits: `node:sqlite`, derived
tables marked rebuildable, meta table, no lossy import);
`src/name-overlay/id.ts` (`bindingKey`/`parseKey` — still the only id
vocabulary); `src/project/revision-store.ts` (the slot/rid/supersede engine
whose semantics §2.3 transcribes into SQL).

What this spec does NOT change: the meaning of a single row. Every table
column below is a spec-10 index field or a spec-11 envelope/record field,
same names, same semantics, same `?`-with-`why` discipline, same token-cost
caps on every query verb. This is a storage+surface consolidation, not a
re-interpretation.

## 0. Where this sits in the pipeline

```
bytecode ──decompile──► AST ──render──► src tree (unchanged, spec 08/10)
                          │
                          └─► hbc2js init ──► <artifact>/project.hbcproj   (ONE file)
                                                │  ix_* tables   = spec-10 index (derived, rebuilt wholesale)
                                                │  revisions/…   = spec-11 annotations (append-only)
                                                │  log           = the git-like change history
                                                ├─► JSON views ──► query verbs (same caps) / JSONL export
                                                └─► tools/projdb/check-db.ts (independent recompute-and-diff)
```

Today spec 10/11 ship a directory of JSONL files plus two services that load
them. Three costs motivate the consolidation:

1. **Cross-store queries are expensive.** "who calls the functions with open
   findings, with their overlay names" needs three full-file scans and an
   in-memory join the loop pays for on every cold start. In SQL it is one
   indexed join (§6 target 3 makes this measurable).
2. **History is per-file, not per-project.** The overlay and each record type
   keep their own append-only timelines; there is no single ordered answer to
   "what changed in this project since yesterday, by whom". The `log` table
   (§2.2) is that answer.
3. **One file travels.** A project is one `.hbcproj` to copy, diff (`sqldiff`),
   back up, or hand to another agent — not a tree of sidecars that can drift
   apart.

Stage-2 success criteria apply IN ORDER, as always: (1) TRUTH — the DB is
derived-or-asserted data with an independent checker (§5); it is never both
producer and validator; staleness is a hard error. Then (2) EFFICIENT TO USE —
same per-verb output caps as specs 10/11, plus faster warm queries and cheap
joins (§6).

## 1. The database file

### 1.1 Name, extension, compatibility

- **Path:** `<artifact>/project.hbcproj` — at the root of the per-bundle
  analysis directory (spec 10 §1), beside `manifest.json` and the rendered
  tree. One database per analysed bundle. The `index/`, `project/` and
  `overlay/` JSONL trees stop being written once a `.hbcproj` exists; they
  remain producible on demand as exports (§3.3).
- **Format: standard SQLite 3.** The custom extension is naming only. The
  file MUST stay openable by ordinary SQLite tools (`sqlite3`, DB Browser,
  `sqldiff`, any driver): no encryption, no custom VFS, no loadable-extension
  dependency for reads. A5 (§7) asserts the 16-byte header is
  `SQLite format 3\0` and that a stock `sqlite3` CLI can run `SELECT` against
  every table and view.
- **Identification inside the file** (so a stray `.hbcproj` is self-describing
  even renamed): `PRAGMA application_id = 0x48425250` (`"HBRP"`),
  `PRAGMA user_version = 1` (the major schema version; a reader seeing an
  unknown major MUST refuse, not guess — spec 10 §1.1 rule, unchanged), plus
  the `meta` table (§2.1).
- **Pragmas at creation:** `journal_mode=WAL`, `foreign_keys=ON`,
  `page_size=8192` (matching spec 15 §2). Services checkpoint + close cleanly
  so the file is single-file at rest (`wal_checkpoint(TRUNCATE)` on service
  shutdown); transient `-wal`/`-shm` sidecars during a session are accepted
  and documented, never required for reading a quiescent project. A
  `.hbcproj` is only handed off / copied / diffed QUIESCED (no live `-wal`):
  copying the main file out from under an open writer can miss checkpointed-
  but-unmerged pages, and that rule is stated wherever hand-off is described.
- **Driver: `node:sqlite`** (built into Node ≥ 22.5; repo runs 25.x). No
  native npm dependency; macOS + Linux (spec 15 principle 6).

### 1.2 What "versioned and logged like git" means, precisely

- Every write to the database — an annotation append, an index rebuild, an
  import, an export — lands as exactly one row in the append-only `log` table
  (§2.2), with a monotonically increasing `seq`, timestamp, actor
  (spec-11 `prov`), operation, and the affected `rid`/generation. `seq` order
  IS the project history; there are no out-of-band writes (enforced: A3).
- Like git, history is append-only and reverts are new entries: spec 11's
  supersede/revert model (§2.3 here) means no row in `revisions` or `log` is
  ever updated or deleted — triggers make UPDATE/DELETE on those tables a
  hard `RAISE(ABORT)` (§2.5), so even a buggy writer cannot rewrite history.
- Unlike git, there is no branching in v1: one linear history per file.
  Two-session merge stays spec 11 §2.3's batch line-union semantics, now as a
  row-union with the same conflict records (§10 Q4).
- `hbc2js project log [--since <seq|iso>] [--who <actor>]` (§3.2) is the
  bounded query over this history — the cross-session "what happened here"
  answer that motivates cost 2 in §0.

## 2. Schema (DDL — normative)

The DDL ships verbatim as `src/projdb/schema.sql` (implementation step 1) and
is applied inside one transaction at `init`. Three strata, with different
mutation rules:

| stratum | tables | who writes | mutation rule |
|---|---|---|---|
| derived index | `ix_*` | index builder only | rebuilt WHOLESALE per generation; read-only otherwise |
| annotations | `revisions` + per-kind detail | `ProjectService` write verbs | append-only, trigger-enforced |
| history | `log` | every writer, same transaction | append-only, trigger-enforced |
| identity | `meta` | init / rebuild | key-value, updates logged |

### 2.1 `meta` — identity and staleness root

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
-- rows: schema='hbc2js-proj/1'; created_at;
--   bundle_sha256, bundle_bytes, hbc_version, function_count   (spec 10 §1.2 bundle block)
--   producer_json      (exact PassPipelineOptions + hbc2js version + git, spec 10 §1.2)
--   index_gen          (integer; bumped by every index rebuild, §5.2)
--   index_built_for    (sha256 over bundle_sha256+producer_json the CURRENT ix_* rows derive from)
--   render_hash        (spec 10 §1.2; the render ix_ranges rows describe)
--   host_globals_sha   (sha256 of the in-repo curated list used at build, spec 10 §2.5)
```

This is spec 10's `manifest.json` `bundle`/`producer`/`index.builtFor` content
relocated into the DB. `manifest.json` itself remains on disk for the rendered
tree (render hash, degraded diagnostics) — the render is still files; only
index + annotations move into the DB.

### 2.2 `log` — the change history

```sql
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
```

- One row per logical write. `op='annotate'` rows are 1:1 with `revisions`
  rows and written in the SAME transaction (A3 asserts the invariant: every
  `revisions.rid` appears exactly once in `log`).
- `op='rebuild-index'` is ONE row per generation (not per ix_ row — rebuilds
  are wholesale, §5.2); `detail` carries per-table row counts and the new
  `index_built_for`.
- Exports and renders are logged too: the history answers "which JSONL
  snapshot did I hand the other agent, and from which seq".

### 2.3 Annotation stratum — envelope + per-kind detail (spec 11 transcribed)

The spec-11 envelope (§2.1 there) becomes one `revisions` table; type-specific
fields become per-kind detail tables joined by `rid`. The slot/rid/supersede
semantics are `src/project/revision-store.ts`'s, unchanged — but `active`
becomes a DERIVED notion (a view), so stored rows are truly immutable:

```sql
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
```

**Active-slot rule (the view that replaces the stored `active` flag):** the
head of a slot is its max `rid`. The slot's active payload is: nothing if
`head.cleared=1`; else `head.reactivates`'s detail row if set; else `head`'s
own detail row. Shipped as `v_active` (one row per non-empty slot: head rid,
payload rid, kind, target). Every read verb goes through `v_active`; the full
timeline stays queryable (`project history <target>` reads `revisions`
directly, bounded). This is exactly RevisionStore's semantics with the
mutable-flag bookkeeping replaced by a derivation — fewer ways to corrupt
history, and A4 (§7) asserts behavioural equivalence against the JSONL engine.

**Names move INTO the database — DECISION, reversing spec 11 §2.4 WRAP for
DB-backed projects only.** Spec 11 ruled WRAP to avoid breaking the shipped
`<hbc>.names.json` contract. That ruling stands for JSONL projects (no
`.hbcproj` present): nothing changes. But a consolidation spec that left names
in a sidecar would fail its own point — the DB must be able to join names with
calls and findings (§6 target 3), and "one file holds both" is this spec's
mandate. So: when a `.hbcproj` exists, `name` CLI verbs and `NameService`
read/write `revisions(kind='name')+d_names` (same gate, same alpha-rename at
render); `hbc2js init --from` imports the existing overlay records preserving
timeline (§4.3); and `<hbc>.names.json` remains available as an EXPORT
(§3.3), so any external consumer of that format keeps working. §10 Q1 asks the
reviewer to confirm this reversal.

**Finding status transitions on the DB path (2026-09-05).** `kind='status'`
is in the `revisions` CHECK list above, but no `d_status` detail table ships
in this DDL, so a transition has nowhere to store its `from`/`to`/`finding`
triple. `ProjectService.setFindingStatus` therefore WRITES a transition as a
fresh `kind='finding'` revision on the finding's own slot (same `finding_no`,
same claim, same severity, the new `status`, the transition's evidence refs
appended after the claim's), and `src/projdb/project-read.ts`'s
`splitFindingRevisions` READS that folding back apart: such a revision is
handed to `FindingStore` as a synthetic `StatusRecord` whose `finding` is the
claim revision it supersedes, and that claim revision stays the live
(`active`) `FindingRecord`. The pair is exactly what spec 11 §1.5 mandates
(an immutable claim row plus an append-only transition chain), so a DB-backed
project and a JSONL-backed one answer `findings`/`finding show`/`stat`
identically, with a finding `rid` that is stable across a transition. A real
`d_status` table would make the write side symmetrical too; until then the
read-side split is the normative reconstruction (docs/BUGS.md 2026-09-05
row).

### 2.4 Derived index stratum — spec 10 §2, one table per JSONL kind

Same fields, same semantics, same sort keys (now `PRIMARY KEY`s). All columns
are spec 10 §2's; no new interpretation.

```sql
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
```

**MIGRATION 5 (docs/BUGS.md 2026-09-05 `ix_calls_resolved` row) adds
`ix_calls_resolved`** — `index/calls-resolved.jsonl`'s own kind (§2.2a, the
`require(N)` points-to pass), a separate table for the same reason it is a
separate JSONL file: it reconstructs a `calls.jsonl` `callee:'?'`
`why:'computed-callee'` edge, never rewrites it.

```sql
CREATE TABLE IF NOT EXISTS ix_calls_resolved (
  caller INTEGER NOT NULL, site INTEGER NOT NULL, callee INTEGER NOT NULL,
  module INTEGER NOT NULL, name TEXT NOT NULL, confidence TEXT NOT NULL,
  PRIMARY KEY (caller, site));
CREATE INDEX IF NOT EXISTS ix_calls_resolved_callee ON ix_calls_resolved(callee);
```

(`fnOwnership` is `ix_functions.module`; spec 10 §2.6 already derives one from
the other.) The `renderIndependent` header bit becomes structural: `ix_ranges`
is the only render-coupled table, and §5.2 keys its staleness to
`meta.render_hash` exactly as spec 10 §4.2 does.

### 2.5 Append-only + read-only enforcement (triggers — normative)

```sql
CREATE TRIGGER log_no_update  BEFORE UPDATE ON log
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: log'); END;
CREATE TRIGGER log_no_delete  BEFORE DELETE ON log
  BEGIN SELECT RAISE(ABORT,'E_APPEND_ONLY: log'); END;
-- same pair on: revisions, d_names, d_comments, d_tags, d_bookmarks,
--               d_findings, d_evidence, d_conflicts
```

- Annotation + history strata: UPDATE/DELETE are impossible at the SQL layer,
  for every writer including a buggy hbc2js. History rewriting requires
  dropping triggers — visible in `sqlite_schema`, and the checker (§5.1)
  verifies the triggers exist and match the DDL.
- Derived stratum: `ix_*` tables carry no triggers — the rebuild (§5.2)
  legitimately replaces them (`DELETE` + reinsert inside one transaction,
  logged as one `rebuild-index` row). Outside a rebuild, services open the DB
  `readonly` for query paths; only the two writer paths (annotate, rebuild)
  open read-write. Discipline, not cryptography: the checker is the guarantee
  that a tampered index is CAUGHT (§5.1), which is the truth property that
  matters.

## 3. JSON as a view: query surface and export

### 3.1 The view layer

For every spec-10 index kind and spec-11 record type, the DDL ships a
`v_json_*` view producing one JSON text per row via SQLite's `json_object()`,
with EXACTLY the JSONL row shape and the JSONL sort order:

```sql
CREATE VIEW v_json_calls AS
  SELECT json_object('caller',caller,'site',site,
           'callee', CASE WHEN callee GLOB '[0-9]*' THEN json(callee) ELSE json_quote(callee) END,
           'kind',kind,'via',via,'why',why) AS j,   -- NULLs elided per JSONL row rules
         caller, site FROM ix_calls ORDER BY caller, site;
-- likewise v_json_functions, v_json_strings, v_json_string_uses, v_json_globals,
-- v_json_native, v_json_modules, v_json_ranges, and for annotations
-- v_json_names / v_json_tags / v_json_comments / v_json_bookmarks / v_json_findings
-- (annotation views emit the spec-11 envelope from revisions ⋈ detail, using
--  legacy_rid when present so a migrated store exports byte-identically, §4.3)
```

JSON is thereby *generated from* relational truth on demand — the DB never
stores a JSON blob that a table also represents (one exception: `meta.
producer_json`, which is opaque config, compared only as a whole). Field-order
and NULL-elision details are pinned by the round-trip test A6, not by prose.

### 3.2 Query verbs: same answers, same caps, served by SQL

Every spec-10 §3.1 and spec-11 §3.1 verb keeps its exact answer shape and its
exact token-cost cap. The implementation changes from "load JSONL, filter in
JS" to a prepared statement with `LIMIT cap+1` (the +1 row proves truncation,
so the `… K more; use --all/--page` marker and the `total:` line stay honest —
totals come from a `COUNT(*)` on the same WHERE). `ArtifactService` and
`ProjectService` keep their public APIs (spec 10 §3.2, spec 11 §3.2) and grow
a DB-backed implementation selected by the presence of `project.hbcproj`;
the loop does not change how it calls them. Live-computed answers stay live:
`context`, `name list`, source slices still come from warm frames (spec 10
§3.3) — the DB stores what the JSONL stored, nothing more.

New verbs this spec adds (all bounded, same discipline):

| verb | answer shape | bound |
|---|---|---|
| `project log [--since s] [--who a]` | one line per log row: `#412 2026-09-03T10:11 llm:run7 annotate tag fn:42 source` | ≤ 50 lines + total |
| `project history <target>` | full slot timeline for a target (supersessions, reverts, who/when) | ≤ 40 lines + total |
| `query annotated-calls [--tag t] [--status open]` | the §6-target-3 join: one line per caller edge into any fn holding a matching active annotation: `fn:12 → fn:42 [finding#3 high open] name:decodePayload` | ≤ 50 lines + total |

### 3.3 JSONL as an export format (kept, demoted from storage)

`hbc2js project export [--dir <out>] [--what index|annotations|names|all]`
streams the `v_json_*` views to the spec-10/11 file tree (`index/*.jsonl`,
`project/*.jsonl`, `overlay/names.jsonl` and/or `<hbc>.names.json`), with the
correct schema-header first lines. Uses:

- **interchange** with anything that speaks the spec-10/11 formats (P2.5 diffs
  two exports as line diffs, unchanged);
- **round-trip verification** (A6, §5.1 step 4): export must byte-match the
  JSONL a spec-10 build of the same bundle produces;
- **escape hatch**: no tool is ever locked in — the DB can always be flattened
  back to greppable text, and `sqlite3` can always read the DB directly.

Every export is a `log` row (op='export', detail: what + output sha256s), so a
handed-off snapshot is traceable to a `seq`.

## 4. `hbc2js init` and migration

### 4.1 `hbc2js init` (fresh project)

`hbc2js init <bundle.hbc> [--out <dir>]` — or run in an artifact directory:

1. decompile + render as today (spec 08/10 path) if not already present;
2. create `project.hbcproj` (§1.1 pragmas, full DDL, `meta` rows) — refuses if
   the file exists (no `--force` overwrite of history; a broken project is
   archived by the human, mirroring spec 10 §1.3's `--overwrite` stance);
3. build the `ix_*` stratum via the EXISTING spec-10 builders
   (`src/artifact/build.ts` walkers) writing rows instead of JSONL lines —
   the extractors are reused verbatim, only the sink changes;
4. leave the annotation stratum empty; write `log` rows `init` +
   `rebuild-index` (gen 1).

After `init`, spec-10/11 JSONL files are no longer written by any command for
this project; they come from `export` (§3.3).

### 4.2 Migration from an existing JSONL project

`hbc2js init --from <artifactDir>` — same as §4.1 but:

- `ix_*` rows are imported from `index/*.jsonl` VERBATIM (no re-derivation:
  the import is a format change, not a rebuild; `meta.index_built_for` copies
  the manifest's `index.builtFor`). Schema-header majors are checked first.
- Annotations: every record from `project/*.jsonl` and the overlay store
  (`overlay/names.jsonl` or `<hbc>.names.json`) is imported in original
  timeline order, envelope → `revisions` (+detail), preserving `ts`, `prov`,
  supersession chains, and storing the original rid in `legacy_rid` (§2.3).
  Nothing is dropped: superseded, reverted, orphaned and conflict records all
  import — the DB inherits the full history, not the active view.
- The source files are READ-ONLY inputs, left untouched on disk; `log` gets
  one `import` row per source file with its sha256 and row count. The human
  deletes the JSONL tree when satisfied (the spec does not auto-delete).
- **Verification is part of the migration:** step 3 of the command runs the
  round-trip — export the freshly imported DB (§3.3) and byte-compare against
  the source files. Any diff = the migration FAILS and removes its partial
  `.hbcproj` (A7). A migration that cannot prove losslessness does not
  complete.

### 4.3 Coexistence rule

One project = one storage backend. If `project.hbcproj` exists, JSONL files in
the same artifact dir are ignored by services (a warning names them, so a
half-migrated state is visible); if it does not, everything behaves as
spec 10/11 today. No dual-write mode, ever — dual-write is how two copies of
the truth drift.

## 5. Truth: independent checking and staleness

### 5.1 The checker — the DB is never both producer and validator

`tools/projdb/check-db.ts` (standalone + wired into `test:all` on fixtures;
CLI `hbc2js project check`):

1. opens the DB with its own raw `node:sqlite` connection (readonly) — it does
   NOT go through `ArtifactService`/`ProjectService`, so a service bug cannot
   vouch for itself;
2. **index truth:** re-decompiles a sample of N functions (default 200,
   `--all`) with `meta.producer_json`'s exact config and re-derives call
   edges, string uses, global accesses, native rows with the spec-10 §4.1
   INDEPENDENT walker (reused from `tools/artifact/check-index.ts` — same
   walker, different row source to diff against). Any unmarked mismatch =
   FAIL with row-level diff; `?` must match as `?` with the same `why` class;
3. **history integrity:** every `revisions.rid` appears exactly once in `log`;
   `seq` is gapless; the append-only triggers of §2.5 are present and
   byte-equal to the DDL's; every slot's supersession chain is acyclic and
   every `supersedes`/`reactivates` points inside the same slot;
4. **view fidelity:** exports the `v_json_*` views to a temp dir and
   byte-compares against a reference JSONL emission (on fixtures: a real
   spec-10 build of the same bundle; on arbitrary projects: re-import the
   export into a scratch DB and compare dumps) — the JSON view layer is
   checked, not trusted;
5. **annotation integrity:** replays spec 11's resolver — every active
   record's target and evidence refs resolve against `ix_*` (spec 11 §4.1);
   orphans carry `ctx` (spec 11 §2.5).

### 5.2 Staleness when the decompile or render changes

Generation model, inheriting spec 10 §4.2's hard line (no `--force`, no
"answer anyway"):

- Every service open + every CLI verb verifies `meta.index_built_for` against
  the current bundle bytes + producer config, and (for line-bearing answers)
  `meta.render_hash` against the live render. Mismatch → `E_STALE_INDEX` /
  `E_STALE_RANGES`, exit non-zero, no output.
- **Same bytes, re-render** (names changed): `hbc2js render` regenerates the
  tree, replaces `ix_ranges` wholesale and updates `meta.render_hash` in one
  logged transaction (op='render'). Semantic tables untouched — the A5-class
  rename-survival property of spec 10 becomes "semantic `ix_*` row sets are
  identical across renders", asserted by A9.
- **Different bytes or config** (re-decompile): `hbc2js project rebuild-index`
  replaces ALL `ix_*` tables in one transaction, bumps `index_gen`, rewrites
  `meta.bundle_*`/`index_built_for`, one `log` row. The annotation stratum is
  NOT touched: append-only history survives every rebuild by construction.
  Spec 11 §2.5's orphan policy then applies unchanged and live — a target
  absent from the new `ix_*` is `orphaned` (computed at query time from
  `v_active ⋈ ix_functions`, never written back), excluded from active reads,
  surfaced by `project orphans` with its `ctx` snapshot. Flag, never drop.
- The DB never silently mixes generations: `ix_*` is only ever written as a
  whole generation, so a query answer is always derived from one coherent
  (bundle, producer, render) triple or it is `E_STALE_*`.

## 6. Decision-8 quadruple (metric / target / method / held-out)

Baselines are the SHIPPED JSONL implementations of spec 10/11, measured by the
same script in the same process style (warm service, same corpus).

| # | metric | target | measured how |
|---|---|---|---|
| 1 | **Truth**: checker (§5.1) — unmarked-wrong index rows on N=200 sampled fns; history-integrity violations; view-fidelity byte diffs; unresolved active annotations | **0, 0, 0, 0** (all derived/asserted data; any disagreement is a bug). `?`-rate and orphan-rate *reported*, not targeted | `tools/projdb/check-db.ts --sample 200 --seed 1` on tuning + held-out projects; one `--all` run on rn-template; numbers in the landing report |
| 2 | **Query cost**: (a) per-answer bytes/lines over the fixed corpus (every spec-10+11 verb × 20 sampled args) — the TOKEN cost; (b) warm per-query latency vs the JSONL services on the identical corpus; (c) cold start (open DB + first `for-fn`) vs JSONL (load index + store + first `for-fn`) | (a) every answer within its existing §3.1 caps — NO regression, byte-for-byte comparable medians; (b) median warm latency ≤ 1.0× JSONL per verb OR within 1 ms absolute, whichever is looser (sub-millisecond medians are noise-dominated; SQL with indexes should win — the target only forbids getting materially slower); (c) cold start ≤ 25% of the JSONL full-load path on the held-out project | `tools/projdb/measure.ts` runs both backends on the same artifact (JSONL via export, §3.3 — same data by construction), emits per-verb median/max for bytes, warm ms, cold ms; best-of-3 |
| 3 | **The join JSONL cannot do cheaply**: `query annotated-calls --status open` (§3.2) — callers into every fn holding an open finding, with active overlay names and tags: a 4-way join (`ix_calls ⋈ v_active(finding) ⋈ v_active(name) ⋈ v_active(tag)`) | warm ≤ 50 ms and ≤ its 50-line cap on the held-out project, against a deterministic seeded annotation set (fixed-seed script in `measure.ts` writing the IDENTICAL records to both backends — ≥ 20 open findings + names + tags spread over indexed fns, counts stated in the report) so the join is non-vacuous; JSONL baseline (full `calls.jsonl` scan + full store scan + in-JS join, implemented once in `measure.ts` as the honest comparator) reported alongside — expected ≥ 10×, but the REPORTED ratio is the deliverable, the 50 ms is the target | same `measure.ts`, best-of-3 |
| 4 | **DB size + held-out check**: `.hbcproj` bytes vs the total bytes of the JSONL files it replaces (index/ + project/ + overlay), same content; and targets 1–3 re-run unchanged on a project never used while building/tuning | size ≤ 1.0× JSONL total on both tuning and held-out (typed columns + no repeated keys must at least pay for page overhead; report the number); targets 1–3 hold on held-out | tune on `tests/fixtures/bundles/rn-template-0.72` + construct fixtures; **held-out = `tests/fixtures/bundles/react-navigation-example-0.85.3`** (real sample bundle, in-repo); spot-check `expensify-app-0.86.0` (large-bundle sanity, numbers in report) |

`measure.ts` prints one summary block; §7's A10 asserts targets 1–2(a) in
`test:all`; the landing report states all four quadruples' measured numbers.

## 7. Acceptance tests

Spec-agent note (CONSOLIDATION §B item 8): A1 is pre-implementation-runnable
and ships here verbatim; the implementer materialises it unchanged as step 0
and the landing report says so. A2–A10 are specified paths + assertions; each
fails before its step lands and passes after. All additions; test-count
baseline only rises. Rung rules hold: property/structural/bounds assertions on
projdb-private fixtures; no exact-output string assertion against a shared
`tests/fixtures/constructs/**` decompile.

**A1 (pre-impl, runnable): DDL self-consistency on a hand-written sample DB.**
`tests/projdb/schema.test.ts` + `tests/projdb/sample/make-sample.sql` (a tiny
hand-written project: meta, 3 functions, 5 calls incl. one `?`, 2 revisions +
log). Built by applying `src/projdb/schema.sql` + the sample INSERTs with
`node:sqlite` in the test itself.

```ts
// tests/projdb/schema.test.ts  (verbatim; implementer materialises)
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const ddl = readFileSync(new URL("../../src/projdb/schema.sql", import.meta.url), "utf8");
const sample = readFileSync(new URL("./sample/make-sample.sql", import.meta.url), "utf8");
const db = new DatabaseSync(":memory:");
db.exec(ddl); db.exec(sample);
test("A1a identity pragmas + meta schema row", () => {
  assert.equal(db.prepare("PRAGMA application_id").get().application_id, 0x48425250);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema'").get().value, "hbc2js-proj/1");
});
test("A1b append-only triggers fire", () => {
  assert.throws(() => db.exec("UPDATE log SET ts='x' WHERE seq=1"), /E_APPEND_ONLY/);
  assert.throws(() => db.exec("DELETE FROM revisions"), /E_APPEND_ONLY/);
});
test("A1c '?' callee requires why (CHECK)", () => {
  assert.throws(() => db.exec(
    "INSERT INTO ix_calls(caller,site,callee,kind) VALUES (1,99,'?','unknown')"));
});
test("A1d every revision is logged exactly once", () => {
  const r = db.prepare(`SELECT (SELECT COUNT(*) FROM revisions) AS n,
    (SELECT COUNT(DISTINCT rid) FROM log WHERE rid IS NOT NULL) AS m`).get();
  assert.equal(r.n, r.m);
});
test("A1e json views parse and are sorted", () => {
  const rows = db.prepare("SELECT j, caller, site FROM v_json_calls").all();
  for (const r of rows) JSON.parse(r.j);
  const keys = rows.map((r) => [r.caller, r.site]);
  assert.deepEqual(keys, [...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
});
```

- **A2 init-on-fixture** (`tests/projdb/init.test.ts`): `hbc2js init` on
  rn-template-0.72; `ix_functions` count == bundle functionCount; `ix_modules`
  agrees with `MODULES.json` id-for-id; `meta.index_built_for` verifies; `log`
  holds exactly `init` + `rebuild-index` gen 1; init on an existing
  `.hbcproj` refuses.
- **A3 history invariants** (`tests/projdb/log.test.ts`): a batch of
  annotation writes via `ProjectService` yields 1:1 `revisions`↔`log(annotate)`
  rows in seq order; gapless seq; a revert appends (never mutates) and
  `v_active` reflects it.
- **A4 revision-engine equivalence** (`tests/projdb/revision-equiv.test.ts`):
  replay a scripted write/supersede/revert/clear sequence against BOTH the
  JSONL `RevisionStore` and the DB stratum; assert identical active-slot
  outcomes and identical timelines at every step. (This is the guard that
  §2.3's derived-active view is RevisionStore, not a re-interpretation.)
- **A5 plain-SQLite compatibility** (`tests/projdb/compat.test.ts`): file
  header bytes are `SQLite format 3\0`; a fresh independent `node:sqlite`
  readonly connection (standing in for any stock tool) can `SELECT` from
  every table and every view without hbc2js code loaded; if a `sqlite3`
  binary is on PATH, shell out `.tables` + one view SELECT (skipped, not
  failed, when absent — mac/Linux rule).
- **A6 export round-trip** (`tests/projdb/export.test.ts`): build the spec-10
  JSONL artifact AND an init'd DB for the same construct-fixture bundle;
  `project export` output byte-matches the JSONL index files; annotate, export
  annotations, re-import into a scratch DB, dumps deep-equal.
- **A7 migration losslessness** (`tests/projdb/migrate.test.ts`): hand-built
  JSONL project (incl. superseded, reverted, orphaned records and an
  overlay store) → `init --from` → export byte-matches every source file;
  `legacy_rid` preserved; then corrupt one source line in a temp copy →
  migration FAILS and leaves no `.hbcproj`.
- **A8 staleness** (`tests/projdb/stale.test.ts`): mutate `meta.render_hash`
  in a temp copy → every line-bearing verb and service construction throw
  `E_STALE_RANGES`; simulate changed bundle bytes → `E_STALE_INDEX`;
  `rebuild-index` on a mutated-bytes artifact bumps gen, logs one row,
  leaves `revisions` untouched, and a now-vanished target shows in
  `project orphans` with its ctx.
- **A9 rename-survival** (`tests/projdb/rename-survival.test.ts`): `name set`
  + `render` on a DB project: semantic `ix_*` row sets identical before/after
  (per-table hash), only `ix_ranges` + `meta.render_hash` changed; `who-calls`
  id-identical.
- **A10 caps + decision-8** (`tests/projdb/targets.test.ts`, in `test:all`):
  runs `measure.ts` corpus on rn-template; every verb within its cap with
  honest truncation markers; `annotated-calls` within its cap; asserts §6
  targets 1–2(a); prints 2(b,c), 3, 4 for the landing report.

## 8. Implementation plan (lean-agent-sized, ordered; reuse column is binding)

| step | delivers | reuses | new |
|---|---|---|---|
| 0 | materialise A1 verbatim + sample SQL; red harness committed | — | `tests/projdb/*`, sample |
| 1 | `src/projdb/schema.sql` (full DDL: tables, views, triggers) + `src/projdb/db.ts` (open/create/verify pragmas+meta); A1 green | spec-15 DDL conventions | schema + open layer |
| 2 | `hbc2js init` fresh path: ix_ builders write rows (sink swap in `src/artifact/build.ts` writers) + meta + log; A2 | `src/artifact/build.ts`, `write.ts` | row sink, init cmd |
| 3 | annotation stratum: DB `RevisionStore` backend + write verbs + `v_active`; A3, A4 | `src/project/revision-store.ts` semantics + its tests as the equivalence script | DB revision backend |
| 4 | DB-backed `ArtifactService`/`ProjectService` query paths (prepared stmts, caps, truncation) + backend selection by `.hbcproj` presence + staleness checks; A5, A8 (stale half) | both services' verb layer + caps | statement layer |
| 5 | export (`v_json_*` streaming) + `init --from` migration with round-trip gate; A6, A7 | spec-10/11 io + headers | export, import |
| 6 | names-in-DB: `name` verbs + render overlay read from DB backend; A9 | `src/name-overlay/{gate,service}.ts` | overlay DB adapter |
| 7 | `project log`/`history`/`annotated-calls` verbs + rebuild-index cmd; A8 (rebuild half) | step 4 layer | 3 verbs + rebuild |
| 8 | `tools/projdb/check-db.ts` (independent reader + spec-10 walker) + `measure.ts`; A10; held-out run; landing report with the four §6 numbers | `tools/artifact/check-index.ts` walker, measure patterns | checker, measure |

Step 1 is the single hard prerequisite. Steps 2–3 are independent after 1;
4 needs 2+3; 5–7 need 4; 8 last. Each step is one commit with its tests.

## 9. Non-goals (v1) and where they attach later

- **Replacing the sigdb** (spec 15): different database, different lifecycle
  (shared/imported vs per-project); they stay separate files. A future
  `ATTACH`-based join (project fns vs signature hits) is a natural follow-up,
  which is exactly why both are plain SQLite.
- **Cross-version id re-binding**: P2.5, unchanged — it consumes `project
  orphans` + exports; the DB adds nothing to fnIndex instability.
- **Branching/live-merge history**: v1 history is linear; merge stays
  spec 11 §2.3 batch semantics (row-union + conflict records) ported in a
  follow-up, not v1 (§10 Q4).
- **FTS5 for `string-grep`**: served as today (scan over `ix_strings`); a
  contentless FTS index is a measured follow-up if target 2(b) shows
  string-grep dominating.
- **Storing rendered source or the bundle in the DB**: the render stays files
  (it is the thing humans read and diff); the bundle stays the bundle.
  `manifest.json` remains for the render side (§2.1).
- **Custom SQLite extensions, encryption, network access**: never — they
  would break §1.1's ordinary-tools promise.
- **Deleting spec-10/11 JSONL support**: JSONL-only projects keep working
  (§4.3); demotion to export-only for DB projects is this spec, deletion is
  a later, separate decision once the loop has run on `.hbcproj` for a while.

## 10. Open questions for the reviewer

1. **Names WRAP→MIGRATE reversal (§2.3).** Spec 11 §2.4 ruled WRAP; this spec
   moves names into the DB for `.hbcproj` projects, keeping `<hbc>.names.json`
   as an export and leaving JSONL projects untouched. Confirm the reversal is
   acceptable on those terms, or require dual support (overlay sidecar even
   when a DB exists — which §4.3's no-dual-write rule argues against).
2. **WAL sidecars vs single-file purity (§1.1).** WAL means transient
   `-wal`/`-shm` files during a session. Alternative: `journal_mode=DELETE`
   (truly single-file, slower writes). Proposal stands: WAL + checkpoint-on-
   close; annotation write volume is human/LLM-paced, but rebuilds bulk-write.
3. **`ix_*` write protection (§2.5).** v1 relies on readonly opens + the
   checker. Should the DDL additionally gate ix_ writes behind a
   `meta.rebuild_in_progress` flag checked by triggers (stronger, more moving
   parts), or is checker-caught good enough for derived data? (Proposal:
   checker is the truth mechanism; add the flag only if a real incident shows
   a writer bug surviving review.)
4. **Merge of two `.hbcproj` files (§9).** Ported line-union merge needs rid
   renumbering (both files own dense rids). Proposal: defer to a follow-up
   spec; v1 refuses `project merge` on DB projects with a message naming the
   export-merge-reimport workaround. Confirm deferral is acceptable.
5. **Cap parity vs SQL-shaped caps (§3.2).** Caps are inherited verbatim for
   parity. Once measured, should any bound be renegotiated (e.g. `project log`
   at 50), or is cap stability across the storage change itself the contract?
   (Proposal: no cap changes in this spec; renegotiations are their own
   reviewed commits, as with spec 10's size renegotiation.)

## 11. Review responses

### Review responses (2026-09-03, Fable reviewer — decision-8 gate)

**Verdict: APPROVED with the three in-place edits below applied (they are in
this commit). Implementation step 0 may launch.** The spec is a storage/
surface consolidation that changes no row semantics, keeps every shipped cap,
and puts truth first: the independent checker (§5.1) re-derives from the
decompiled AST via the spec-10 walker on its own raw connection — the DB is
never both producer and validator. The append-only `revisions`/`log` strata
with `RAISE(ABORT)` triggers, the derived `v_active` slot rule (mutable
`active` flag eliminated), query-time orphan computation ("flag, never
drop"), and rebuilds that never touch the annotation stratum are all
consistent with spec 11's zero-silent-drop rule. The view layer generates
JSON from relational truth with honest `LIMIT cap+1` truncation and
`COUNT(*)` totals — nowhere does a cheaper answer replace a truer one.

**Decision-8 quadruple — sound and measurable as edited.** Baselines exist
(spec 10/11 are shipped, STATUS P2.1/P2.2 complete); fixtures are named and
in-repo; the held-out project (react-navigation-example-0.85.3) was not used
for tuning. Target 1's 0/0/0/0 is right for derived/asserted data, with
`?`-rate reported not targeted. Two measurability holes were fixed in place:
(1) §6 target 2(b)'s bare "≤ 1.0× JSONL" would fail on timer noise for
sub-millisecond verbs — now "≤ 1.0× OR within 1 ms absolute, whichever is
looser"; (2) §6 target 3 was vacuous on a pristine held-out project (no
annotations → empty join, trivially ≤ 50 ms) — `measure.ts` now seeds a
deterministic, identical annotation set into both backends and reports the
counts. Target 4's ≤ 1.0× size holds only at real-bundle scale (JSONL's
repeated keys pay for b-tree overhead); on tiny construct-fixture projects
fixed page overhead will exceed JSONL — fine, because the target is scoped to
the two named real bundles, and the number is reported either way.

**Rulings on §10:**

1. **Names WRAP→MIGRATE for DB projects: CONFIRMED as proposed.** Spec 11
   §2.4's WRAP protected a shipped contract; this spec keeps that contract in
   both senses that matter — JSONL-only projects are untouched, and the
   `<hbc>.names.json` *format* survives as an export any consumer can request.
   Dual support (live sidecar beside the DB) is the one wrong answer: it is
   exactly the two-copies-of-truth drift §4.3 forbids. A consolidation that
   left the highest-value record type outside the join surface would fail §6
   target 3 and the spec's own mandate. Condition (already satisfied by
   §4.3's warning naming ignored files): a leftover `names.json` in a DB
   project must never be silently readable as live — the warning plus
   export-on-demand is the sanctioned path.
2. **WAL: CONFIRMED.** Transient `-wal`/`-shm` with `wal_checkpoint(TRUNCATE)`
   on close gives single-file-at-rest, which is the property that matters for
   a distributable `.hbcproj`; `journal_mode=DELETE` buys nothing but slower
   rebuild transactions. The real portability hazard is copying the main file
   while a live `-wal` exists — now stated as a hard hand-off rule in §1.1
   (edit above).
3. **`ix_*` protected by checker + readonly opens: SUFFICIENT for v1.**
   Derived data's truth mechanism is recompute-and-diff, not write
   prevention — the JSONL index had no write protection at all, so this is
   strictly stronger. A trigger-gated `rebuild_in_progress` flag would itself
   be mutable state a buggy writer could set, adding moving parts without
   adding truth. Adopt the author's trigger-only-if-incident stance.
4. **Merge deferral: CONFIRMED.** rid renumbering across two dense keyspaces
   is a real design (it interacts with `legacy_rid`, `log.seq`, and conflict
   records) and rushing it risks the history stratum. v1's refusal message
   MUST name the export → spec-11 JSONL merge → `init --from` workaround (the
   spec says so), which loses nothing since the export is lossless (A6/A7).
5. **Cap parity: CONFIRMED as a hard contract for this spec.** Holding caps
   fixed is what makes target 2(a) a controlled experiment — change storage
   OR contract, never both in one commit. Renegotiations (e.g. FTS5-backed
   string-grep, `project log` at 50) are their own reviewed commits with
   their own measurements, exactly as spec 10's size renegotiation was.

**Migration: sound.** `init --from` is verbatim-import + byte-round-trip-or-
fail with partial-`.hbcproj` removal (A7) — a migration that cannot prove
losslessness does not complete, and it never mutates its inputs. The §4.3
one-backend rule with a visible warning is the right anti-drift stance. One
noted weakness, acceptable: the checker's view-fidelity step on *arbitrary*
projects (export → scratch re-import → dump-compare) proves idempotence, not
format fidelity; format fidelity is proven on fixtures against a real spec-10
build (A6), which covers the emitter code paths.

**Implementation plan: lean-sized and correctly ordered** (0→1 serial; 2∥3;
4 after both; 5–7 after 4; 8 last). Step 4 is the largest (two services'
statement layers + staleness) but stays one coherent commit. **Orchestrator
sequencing note — steps that touch other lanes' files:** step 2 edits
`src/artifact/build.ts`/`write.ts` (artifact lane), step 3 builds against
`src/project/revision-store.ts` and reuses its tests, step 4 edits both
services, step 6 edits `src/name-overlay/{gate,service}.ts` (overlay lane).
No other lane should have those files open concurrently; step 8's checker
reuses `tools/artifact/check-index.ts`'s walker — reuse, do not fork it.

**Gate decision: step 0 (materialise A1 verbatim + sample SQL, red harness)
may launch now.** A1 is pre-implementation-runnable as required by
CONSOLIDATION §B item 8 and asserts the right invariants (identity pragmas,
append-only aborts, `?`-requires-`why`, revision↔log 1:1, sorted parseable
views).
