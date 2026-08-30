# Known bugs ledger

Every bug found that is not yet fixed-with-a-regression-test lives here until it is. Rows are removed only when a test exists. Format: date · source (review/sweep/user) · component · one-line description · why no test yet · owner.

| date | source | component | description | why no test yet | owner |
|---|---|---|---|---|---|

| 2026-08-30 | review M4-M8 | `src/deps/dscan.ts` | calls `readLiterals(mod.literalValueBuffer, …)` without a version, so at v≥97 (every `literalValueBuffer` module) a tag-6 run is read as a 1-byte ByteString instead of payload-less `Undefined` and the rest of the run desynchronises | **fixed in code** (deps review, 2026-08-30: the version is now passed); no gate fixture is a v≥97 Metro bundle, so the regression check is the sweep-tier react-navigation-example (hbc98) inventory test until one exists | deps lane |
