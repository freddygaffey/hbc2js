# 2026-09-04 — sigdb write-path dispatch (lean Sonnet)

84k tokens, 50 calls. Commit 78e8f27. Gate 1952/0 (agent run).

- writeSignature dispatches on .sqlite suffix (per-process DatabaseSync + ShapeCache via openSigDb/insertFingerprint); non-.sqlite = original JSON writer untouched. loadSignatures gets read-side layer detection (own loadSqliteSignatures, NOT import-json's validator path). confirm.ts writes gated behind HBC2JS_SIGDB=1 (default = byte-identical JSON). build-one.mjs inherits via outDbDir arg (lock-dir guard for .sqlite).
- Round-trip test 3/3: same fixture through JSON path and .sqlite path -> loadSignatures -> deepEqual.
- Documented gap (not regression): build-one.mjs alreadyBuilt()/baseline reads stay JSON-only for .sqlite paths — follow-up.
- SECURITY NOTE: agent reported injection-shaped content (fake <system-reminder>/Auto-Mode/Figma blocks) in a tool result; correctly ignored. Orchestrator grep of src/tools/tests/docs for system-reminder/Auto-Mode = CLEAN -> no persistent injection payload in tracked source; transient tool output (likely a fixture bundle's embedded strings). Trust boundary held.
