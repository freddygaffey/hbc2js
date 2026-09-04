# 18 — Project storage, integrity, and the `hbcproj` CLI

Reading list: `docs/AGENT-BRIEF.md`, this file. Relates to: spec 11 (project
store — this revises its durability model), spec 16 (storage — the DDL/query
work becomes the cache index here), spec 17 (MCP harness — this is the storage
layer the MCP reads/writes). Prompted by the storage design worked through with
Fred, 2026-09-03/04.

## 1. Purpose
Define how an analysis project persists: what is authoritative, what is
rebuildable, how integrity and audit are guaranteed, and the CLI that moves state
between the database and the git-tracked JSON. Requirements it must meet:
transactional writes, git/grep/inspection of state, verifiable recovery, a
replayable audit trail, safe concurrency, and a sanctioned hand-edit path — with
no black box (always one `cat` from the truth).

## 2. Model (one sentence each)
- **The DB is the operational source of truth** — transactional, queryable; every
  MCP/CLI write commits here first. (SQLite; durable via ACID.)
- **The hash-locked JSON is the durable form** — git-tracked, sharded, the thing
  that outlives the DB and can regenerate it. It is a **git-style working tree**
  over the DB: readable, grep-able, *hand-editable*, re-adoptable.
- **The hash is the divergence detector + integrity proof** — a shard whose
  content-hash ≠ its recorded hash is an unadopted working-tree edit; a
  hash-chained log makes history tamper-evident and replayable.
- **Derived indexes are a disposable cache** — xref, scan results; rebuilt from
  the bundle; gitignored.

## 3. Directory layout — a project is `<name>.hbcproj/`
```
bundle.hbc                 # input (or its sha256)
src/                       # decompiled source — FILES, git-tracked
analysis/                  # AUTHORITATIVE state — sharded JSON, git-tracked, hash-locked
  names/<module>.json      # {fn,reg}->name, one file per module
  findings/<id>.json       # one file per finding
  annotations/<module>.json
log/<date>.jsonl           # append-only, hash-chained audit trail — git-tracked
index/*.jsonl              # xref (calls/strings/globals/native) — rebuildable, gitignored
scans/*.jsonl              # secrets/osv/semgrep — precomputed, rebuildable, gitignored
cache.db                   # SQLite: operational store + query index — gitignored, rebuildable
.gitignore                 # cache.db, index/, scans/
```
Git-tracked = `src/`, `analysis/`, `log/`. Gitignored = `cache.db`, `index/`,
`scans/` (one command rebuilds them).

## 4. The boundary rule (what goes where)
- **Authoritative** (a human/agent produced it, or it records what happened) →
  sharded JSON in `analysis/` + `log/`, git-tracked, hash-locked. Materialised in
  the DB for queries.
- **Derived** (a machine can regenerate it from the bundle) → `index/`, `scans/`,
  `cache.db`; gitignored; rebuildable.

## 5. Hashing & integrity
- **Per-shard content hash**: each JSON shard records the hash of its own content;
  recompute-and-compare detects any out-of-band edit. Self-contained (no DB).
- **State binding**: each shard records the DB version + state hash it was exported
  from, so an export is provably tied to a known DB state.
- **Hash-chained log**: each `log/` entry chains the previous entry's hash →
  tamper-evident, replayable history. Each entry also records the **affected
  shard id(s) and their post-write content hashes** — this is what makes the
  pre-commit "log covers the changed shards" check (§11a-b) verifiable with no
  DB. The chain spans daily files: the first entry of `log/<date>.jsonl` chains
  from the last entry of the previous file. IDs are content-hashes (§7).

## 6. Write path (DB-first, then export)
1. Validate the write (schema + referential integrity).
2. Commit to `cache.db` in a transaction (compound writes — a finding + its
   evidence refs + status — are all-or-nothing).
3. Export the affected shard(s) to hash-locked JSON; append the mutation to the
   hash-chained log with `provenance` (mcp | cli | human-file-edit).
DB-first is required because writes are compound; multi-file JSON writes are not
atomic, a transaction is.

## 7. Finding-ID allocation (no shared counter)
IDs are **content-hashes** of the finding's **immutable defining fields**
(target, kind, evidence anchor — never status, severity edits, or notes, so the
id is stable across the finding's lifecycle) — no global `F-0001` sequence (which would reintroduce the contention sharding removed) and dedup for
free (same finding ⇒ same id). Optional human-readable form: `<run-prefix>-<n>`
with a per-run prefix, never a shared counter.

## 8. DB↔JSON contract & recovery (crash-safe, self-healing)
- **Live**: the DB is durable (SQLite ACID). If a crash lands between the DB
  commit and the JSON export, the JSON lags; on restart, re-export any **lagging**
  shard — one whose file content still matches its recorded hash but whose state
  binding (§5) is older than the DB's current export version. **The DB wins** (it
  committed first). A shard whose content ≠ its recorded hash is a **hand edit,
  not lag**: crash recovery never touches it — it goes through §10 (`adopt` /
  `restore` / conflict), so auto-re-export can never silently clobber an
  un-adopted hand edit. (Reviewer edit R1: the previous wording re-exported on
  any hash mismatch, which would have destroyed hand edits on restart.)
- **Recovery / fresh clone**: if `cache.db` is absent or corrupt (e.g. a git
  clone with only the JSON), rebuild it from the hash-verified JSON. **The JSON
  wins** (it is all that exists).
- **Arbitration**: the more-recent hash-consistent side wins; the hash makes every
  mismatch *detectable*, so the system reconciles before serving — never a wrong
  answer. The DB is therefore disposable despite being the operational truth.

## 9. The `hbcproj` CLI (git-style porcelain)
| verb | direction | does |
| --- | --- | --- |
| `status` | — | show shards diverged from the DB, and the direction |
| `diff <shard>` | — | what adopting a hand edit would change, before committing |
| `adopt <shard\|--all>` | JSON→DB | import a hand edit: **validate, apply in a txn, log (`provenance:human-file-edit`), re-lock hash** |
| `restore <shard\|--all>` | DB→JSON | discard a hand edit, re-export from the DB (DB wins) |
| `rebuild` | JSON→DB | full regeneration (recovery / fresh clone) |
| `export` | DB→JSON | materialise JSON from the DB |
| `verify [--full]` | — | check content hashes + log chain; `--full` re-runs validators (CI) |
| `init` | — | scaffold the project; install the git pre-commit hook |

Flags: `adopt` acts only on diverged shards and needs `--adopt`/confirm (it
overrides the lock); `--dry-run` previews; `--force` resolves conflicts (§10).

## 10. Conflict resolution (three-way, git-style)
Track a **base hash** per shard (last time DB and JSON agreed). On `adopt`:
- file changed, DB unchanged since base → clean adopt;
- DB changed, file unchanged → nothing to adopt (`restore` if stale);
- **both changed since base → conflict**: refuse without `--force`, show the diff,
  require explicit resolution. v1 is refuse-and-resolve; `--ours`/`--theirs` later.

## 11. Git integration (integrity enforced by git)
- **Pre-commit hook** (installed by `init`; cheap, no DB): (a) every staged shard's
  content-hash matches its recorded hash; (b) the log chain is intact and covers
  the changed shards. A mismatch blocks the commit with: *"shard X diverged — run
  `hbcproj adopt X` or `hbcproj restore X`."* This makes git structurally unable to
  record state that skipped `adopt`.
- **CI `hbcproj verify --full`**: the non-bypassable gate (pre-commit is local and
  `--no-verify`-able), matching the repo's gate-guarded-push culture. Same check,
  three places: CLI on demand, hook at commit, CI at push.

## 12. Relationship to other specs
- **Revises spec 11**: the project store's DB stays the *operational* authoritative
  store (retained, not superseded), but is no longer the only durable form — the
  hash-locked JSON is the durable/recoverable authority, and `open→confirmed` /
  status rules move with it. (Corrects the earlier files-first reading that said
  the DB store was superseded.)
- **Revises spec 16**: its "the database becomes THE storage; JSON/JSONL a
  generated view, never the storage itself" framing is **superseded** by §2 —
  the DB is retained as the operational store, but the hash-locked JSON is the
  durable authority. Its DDL/query work is kept as `cache.db`'s index layer,
  and the shipped DB write path (c02c1b3: `ProjectService` → `.hbcproj` via
  `DbRevisionStore`, with log rows) is the §6 step-2 substrate this spec builds
  on — implementation ADDS shard export + porcelain on top of it, it does not
  replace it.
- **Feeds spec 17**: the MCP reads `cache.db` for speed and writes via §6; it
  serves nothing that does not also exist as a file.

## 13. Non-goals (v1)
- **Human editing UI** (Ghidra-style) — worthwhile, but **Stage 3**. Until then,
  the LLM writes via MCP and humans hand-edit JSON + `adopt`.
- `--ours`/`--theirs` auto-merge — later; v1 refuses conflicts.

## 14. Acceptance tests
1. Round-trip: write via MCP → export → `rebuild` from JSON → DB byte-identical.
2. Hand-edit → `adopt` validates, logs (`provenance:human-file-edit`), re-locks;
   an **invalid** hand edit is refused with a reason, DB untouched.
3. Crash sim: kill between DB commit and export → restart re-exports the lagging
   shard; DB wins; no wrong answer.
4. DB-loss sim: delete `cache.db` → `rebuild` reconstructs from hash-verified JSON.
5. Conflict: both DB and file changed since base → `adopt` refuses without
   `--force`, shows the diff.
6. Finding ids are content-hashes; two concurrent runs never collide; identical
   findings dedup.
7. Pre-commit hook blocks a committed shard whose content-hash mismatches; passes
   an adopted one. `verify --full` catches an invalid shard the cheap check misses.
8. Sharding: two agents naming different modules write different files with no
   contention.

## 15. Open questions
- `--full` validation cost in CI on a large project — sample or full?
- Log rotation/compaction while keeping the chain verifiable.
- Whether `index/`/`scans/` should be optionally committable for offline review.

## Review responses (2026-09-04, Fable — decision-8 gate review)

**Verdict: APPROVED AS AMENDED.** The two-authority model is coherent and the
amendments below were applied in place (R1–R4); the spec was missing its
decision-8 quadruple and an ordered implementation plan, supplied here (§R3/§R4)
as review-owned additions. Implementation may start at step 0.

### R1. Soundness rulings on the model (checks against the decided architecture)
1. **Authority/recovery direction — coherent, one fix applied.** Live: DB wins
   (committed first). Fresh clone / lost DB: JSON wins (rebuild). Both
   directions are stated (§8). Fixed in place: crash-recovery re-export
   previously triggered on *any* hash mismatch, which would have silently
   clobbered an un-adopted hand edit on restart; §8 now distinguishes *lag*
   (content matches recorded hash, state binding older than DB) from *hand
   edit* (content ≠ recorded hash → §10 path, never auto-overwritten).
2. **Hash-lock enforcement — sound, one fix applied.** Hook check (b) ("log
   covers the changed shards") was unverifiable without the DB until §5 was
   amended: log entries now record affected shard ids + post-write content
   hashes, and the chain is defined across daily files. Note the residual,
   acceptable hole: a hand editor who also recomputes the recorded hash *and*
   forges a chained log entry defeats the cheap hook — but not CI
   `verify --full` (validators + DB-state binding), which is the non-bypassable
   layer. Tamper-*evident*, not tamper-*proof*, is the design intent; fine.
3. **Content-hash finding ids — confirmed** as removing the shared counter
   (the concurrency win) and giving dedup. Fixed in place: the hash covers
   only immutable defining fields, so a status transition cannot change the id.
4. **Spec 11/16 reconciliation — one dangling contradiction fixed.** §12 now
   explicitly supersedes spec 16's "DB is THE storage; JSON a generated view"
   framing (the exact inverse of this spec) while keeping its DDL as
   `cache.db`. Spec 16's status header should gain a one-line pointer to this
   spec when implementation starts (orchestrator task, not done here).
5. **Consistency with shipped code — confirmed.** c02c1b3 already lands
   ProjectService writes in the `.hbcproj` DB with log rows: that IS §6 step 2.
   §12 (amended) and the plan below build shard export + porcelain ON TOP of
   it; nothing shipped is replaced.

### R2. Rulings on §15 open questions
- **CI `--full` cost**: run FULL on every push while projects are small; budget
  `verify --full` ≤ 60 s on the largest in-repo project, measured in CI. Only
  if measured over budget: verify changed shards fully + a random sample of the
  rest, recorded as a decision with the measurement. No pre-emptive sampling.
- **Log rotation/compaction**: DEFERRED — v1 never compacts; daily-file
  rotation with cross-file chaining (§5, amended) is sufficient. Any future
  compaction must keep the chain verifiable from genesis (checkpoint-hash
  design); that is its own spec.
- **Committable `index/`/`scans/`**: NO for v1 — committing derived state
  reintroduces exactly the drift the §4 boundary rule exists to prevent.
  Offline review uses `hbcproj rebuild` on the clone. Revisit only with a
  concrete offline-review need, as a separate decision.

### R3. Decision-8 quadruple (was missing — supplied; targets are review-owned)
- **Metric 1 — round-trip integrity.** Method: seed a project with writes
  across all record types via the shipped write path; `export` → delete
  `cache.db` → `rebuild`; compare semantic dumps. Target: 100% equality.
  Held-out: a second seeded project generated from a fuzzer seed fixed only
  after implementation lands.
- **Metric 2 — divergence detection.** Method: mutation harness applies ≥100
  random out-of-band edits (shard bytes, recorded hashes, log entries, chain
  links); run `verify --full`. Target: 100% detected. Held-out: mutation seeds
  fixed post-implementation.
- **Metric 3 — concurrency.** Method: two concurrent writers record 1000
  findings across overlapping modules. Target: 0 id collisions, 0 lost writes,
  dedup on identical findings.
- **Run cost**: acceptance suite (§14) ≤ 120 s locally; `verify --full` ≤ 60 s
  in CI (per R2 ruling).

### R4. Ordered implementation plan (lean-agent-sized; was missing — supplied)
Each step is one lean-agent task, ships with its tests, lands independently:
0. **`export` + hash lock**: materialise `analysis/` shards (names, findings
   with content-hash ids, annotations) from the existing `.hbcproj` DB
   (c02c1b3 substrate), per-shard content hash + state binding (§5).
   Deterministic output; round-trip-ready. *(May launch now.)*
1. **`rebuild` + `verify`**: DB regeneration from hash-verified JSON; hash +
   chain checks; `--full` validators. Closes acceptance tests 1, 4, 7(half),
   metric 1.
2. **Write-path export + chained log**: after each DB txn, export affected
   shards and append the §5 log entry (extend c02c1b3's log rows with
   chain + shard hashes). Closes test 3 (crash sim), metric 2 substrate.
3. **`status`/`diff`/`adopt`/`restore`** with base-hash three-way (§10).
   Closes tests 2, 5.
4. **`init` + pre-commit hook + CI wiring**. Closes test 7; enforces §11.
5. **Concurrency proof**: metric 3 harness; tests 6, 8.

