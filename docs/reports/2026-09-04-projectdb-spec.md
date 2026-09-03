# 2026-09-04 — project database spec (lean Fable; completed from spend-limit WIP)

47k tokens (resume), draft was substantively complete at 54fbb14. Commit c7afe76, docs/specs/16-project-db.md.

- .hbcproj = standard SQLite (app_id HBRP, WAL). Strata: meta (staleness root: index_gen/render_hash), log (append-only write history), annotations (revisions envelope + per-kind detail, active = derived v_active view), derived ix_* mirroring spec-10 JSONL column-for-column. Triggers ABORT any UPDATE/DELETE of history/annotations.
- JSON-as-VIEW: v_json_* views emit exact JSONL shapes via json_object(); every spec-10/11 verb keeps its shape + token cap (LIMIT cap+1 truncation). JSONL survives only as `project export`.
- Migration: hbc2js init (fresh, spec-10 builders + row sink) / init --from <artifactDir> (import JSONL verbatim, legacy_rid preserved, byte-round-trip-or-fail). .hbcproj present => JSONL ignored, never dual-write.
- Decision-8: checker 0/0/0/0; caps preserved, warm latency <=1.0x JSONL; annotated-calls 4-join <=50ms warm; DB size <=1.0x JSONL. Held-out react-navigation.
- 5 open questions -> review gate (names WRAP->MIGRATE reversal; WAL sidecars vs single-file; checker-only ix_* protection; defer .hbcproj merge; cap parity as contract).
