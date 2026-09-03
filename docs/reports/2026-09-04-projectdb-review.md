# 2026-09-04 — project-DB spec review gate (lean Fable) — APPROVED w/ edits

47k tokens, 13 calls. Commit 7554423.

- Truth sound: checker on its own raw connection (never producer+validator); ABORT triggers + v_active + query-time orphans honor zero-silent-drop; view layer honest (LIMIT cap+1, COUNT totals). Migration byte-round-trip-or-fail; no dual-write.
- 2 measurement holes fixed in place: target 2(b) latency gains a 1ms noise floor; target 3 was vacuous on a pristine held-out project -> measure.ts seeds an identical annotation set into both backends. §1.1 added: hand off .hbcproj only quiesced (no live -wal).
- 5 rulings (all per author): names WRAP->MIGRATE confirmed (JSONL projects untouched, names.json survives as export); WAL ok w/ checkpoint-on-close single-file-at-rest; checker-only ix_ protection sufficient (strictly stronger than JSONL); merge deferral ok w/ export->merge->reimport workaround; cap parity = hard contract.
- Step 0 may launch: materialize A1 red harness (tests/projdb/schema.test.ts + sample SQL). Steps 2/4/6 touch artifact/services/name-overlay lanes (orchestrator sequencing).
