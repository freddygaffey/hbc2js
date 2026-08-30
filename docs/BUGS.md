# Known bugs ledger

Every bug found that is not yet fixed-with-a-regression-test lives here until it is. Rows are removed only when a test exists. Format: date · source (review/sweep/user) · component · one-line description · why no test yet · owner.

| date | source | component | description | why no test yet | owner |
|---|---|---|---|---|---|

| 2026-08-30 | deps | `hbc2js deps --json` output truncated at 64 KB when piped (process.exit before stdout flush) | found by overseer 2026-08-30 | fix in deps review |
| 2026-08-30 | review M4-M8 | `src/deps/dscan.ts` | calls `readLiterals(mod.literalValueBuffer, …)` without a version, so at v≥97 (every `literalValueBuffer` module) a tag-6 run is read as a 1-byte ByteString instead of payload-less `Undefined` and the rest of the run desynchronises | `readLiterals` now takes an optional `version` (see `tests/gate/parse/literals.test.ts`); passing it is a one-line change in a file this task does not own | deps lane |
