# 2026-09-04 — project-DB step 4: DB-backed query layer (lean Sonnet; orchestrator-salvaged)

204k tokens (2x over budget — OUTLIER; agent also failed to land: terminated "waiting" on a run_in_background gate it couldn't read, left work uncommitted + a respawning orphaned gate the orchestrator had to kill). Orchestrator ran the clean gate (1980 tests, 0 fail) and committed.

- src/projdb/artifact-read.ts: DB read path (hasProjectDb, readonly open, meta/manifest synth, checkDbStaleness E_STALE_*, loadIndexRowsFromDb prepared SELECTs into exact JSONL row shapes).
- src/artifact/service.ts: constructor branches on .hbcproj; both backends funnel through one populateFromRows() so caps/slice/truncation are byte-identical across backends (cap parity structural, not duplicated).
- src/projdb/project-read.ts: ProjectService DB read via step-3 DbRevisionStore + exported DetailAdapters; ProjectService inherits staleness (stale ArtifactService never constructs).
- revision-store.ts: DbRevision gained ctx/prov read-back; annotations.ts exported per-kind adapters.
- A5 (compat) + A8-stale-half green. BUGS row added: status/conflict reconstruction gap (no d_status table in DDL; conflicts deferred).
- PROCESS LESSON: brief agents to NEVER end a turn waiting on a run_in_background gate — run gate foreground or commit-then-report; the wait-and-terminate pattern balloons tokens AND fails to land.
