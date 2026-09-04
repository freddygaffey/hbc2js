# 2026-09-04 — spec 18 step 4: init + pre-commit hook + CI verify (lean Sonnet)

122k tokens (near budget), 90 calls. Commit b57b777, gate 2061/0 foreground (pipeline-speed flake isolated-confirmed, 2nd run clean).

- runInit writes src/ + .gitignore + installs the hook; new `hbcproj install-hooks`; src/projdb/hooks.ts installPreCommitHook.
- HOOK PROVEN: greps staged analysis//log//project.hbcproj, runs fast `hbcproj verify`, blocks commit on nonzero + prints adopt/restore remediation. Test: real git commit against a hand-edited shard FAILS (count stays 1), commits after `hbcproj adopt` (count 2); src/-only commits never blocked.
- CI: build-test runs node dist/cli.js init/export/verify --full on a fixture — the non-bypassable twin of the --no-verify-able local hook.
- BONUS pre-existing bugs caught+fixed: adopt --who arg parse; dist/cli.js missing schema.sql/sigdb-schema.sql (new tools/copy-build-assets.mjs + build script). test-count baseline 929->959.
- NEXT: step 5 concurrency proof (§R3 metric 3: 2 writers, 1000 findings, 0 id collisions / 0 lost / dedup; tests 6,8). LAST spec-18 step.
