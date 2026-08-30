# Known bugs ledger

Every bug found that is not yet fixed-with-a-regression-test lives here until it is. Rows are removed only when a test exists. Format: date · source (review/sweep/user) · component · one-line description · why no test yet · owner.

| date | source | component | description | why no test yet | owner |
|---|---|---|---|---|---|

| 2026-08-30 | deps | `hbc2js deps --json` output truncated at 64 KB when piped (process.exit before stdout flush) | found by overseer 2026-08-30 | fix in deps review |
