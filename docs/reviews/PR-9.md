# Review: PR #9 (`claude/hbc2js-tasks-a1cjkc` @ b7c4897) — T13 + #6 fix

Reviewer: Claude Sonnet 5, 2026-08-30. Scope: T13 (`docs/lowering/generators.md`,
`docs/lowering/async-await.md`, `docs/LOWERING-CATALOGUE.md`) and the #6 test-guard
fix (`tests/gate/harness/cli.test.ts`, `tests/gate/harness/tiers.test.ts`); the
already-approved `docs/reviews/ARCH-2026-08-30.md` was not re-reviewed. Method:
diffed the PR's own commits against `origin/main` (not the raw branch diff, which
also reflects `origin/main` advancing past the branch's last merge — see F1),
re-ran `node src/cli.ts disasm` on the cited fixtures independently, ran the two
guarded test files with `hermesc` present/absent/absent+`HBC2JS_REQUIRE_ORACLES=1`,
and merged the branch onto current `origin/main` in a scratch worktree.

## Verdict: **MERGE**

## Findings

**F1 — apparent scope creep is branch staleness, not the PR's doing (informational).**
`git diff --stat origin/main..origin/claude/hbc2js-tasks-a1cjkc` shows
`.github/workflows/ci.yml`, `tools/oracles/requirements-hermes-dec.txt`,
`tests/gate/docs/decisions-headings.test.ts` (deleted), and part of
`docs/STATUS.md`/`docs/AGENT-LOG.md` — none of which the brief's scope mentions.
Checked commit-by-commit: these all belong to `origin/main`'s `a72f7b5` ("CI fix
#2"), landed *after* the PR branch's last merge from main (`d651b2d`); the PR
branch simply hasn't picked it up yet, it never touched those files. The PR's own
five commits (`f22d884`, `ca8d2e1`, `4ef4579`, `ef32336`, `8a54771`) touch exactly
`docs/reviews/ARCH-2026-08-30.md`, `docs/lowering/{generators,async-await}.md`,
`docs/LOWERING-CATALOGUE.md`, `docs/TASKS.md`, `docs/AGENT-LOG.md`, and
`tests/gate/harness/{cli,tiers}.test.ts` — matches the stated scope exactly, no
`src/**` touched. No fix needed; the merge (F4) shows this resolves cleanly.

**F2 — T13 rows independently reproduced, confidence labels honest.** Ran
`node src/cli.ts disasm` on `24-generator-return-throw` and `23-generator-basic`
at v98/v99, and `27-async-await-basic` at v98/v99, on a checkout of the PR tip.
- Function #3 (`g1` body) in `24-generator-return-throw` is byte-for-byte
  instruction-identical between v98 and v99 (`diff` of the two dumps: no output),
  matching the doc's verbatim excerpt exactly, including register numbers.
  `LoadParam 1` (action) vs `LoadParam 2` (value), action codes `1`=`.throw()`
  (sets status 3, `Throw r0`), `2`=`.return()` (status 3, `NewObjectWithBuffer`
  + `PutOwnBySlotIdx …, r0, 0`, `Ret`), status `2` re-entry trap calling
  `CallBuiltin b44 "throwTypeError"`, status `3` completed trap — all confirmed
  against the actual dump, not just the doc's transcription of it.
- Slot-numbering claim confirmed too: `24-generator-return-throw` reads status
  from env slot 0 (`LoadFromEnvironment r0, r1, 0`); `23-generator-basic`'s
  `counter` reads status from slot 3 and the resume index from slot 2, with slot
  0 used for the captured `max` parameter (`LoadFromEnvironment r7, r1, 0` inside
  the loop-continuation check) — exactly as claimed.
- `27-async-await-basic`'s `sequence` (function #2) at v98 emits
  `GetBuiltinClosure r3, b57 "spawnAsync"`; at v99, `GetBuiltinClosure r3, b58
  "makeAsyncIterator"` — both followed by the identical
  `Call4 r1, r3, r0, r2, r1, r4` shape. Matches the doc's claim precisely.
- Confidence markers (⛔ → ✅ measured, T13) are justified by this evidence, not
  overclaimed — the doc still correctly flags what remains unpinned (action
  codes above 2, `.return()`'s result-object shape in every case).

**F3 — #6 fix verified behaviourally in all three modes.** In a scratch worktree
of the PR tip with `tools/hermesc` absent (the worktree's own, uncontaminated by
the main tree): `node --test tests/gate/harness/cli.test.ts
tests/gate/harness/tiers.test.ts` → 12 pass / 0 fail / 2 skipped, both skips
naming `hermesc v94`. Same run under `HBC2JS_REQUIRE_ORACLES=1` → 2 fail, both
throwing `hermesc v94 required for the … oracle set (HBC2JS_REQUIRE_ORACLES=1)`.
With `tools/hermesc` symlinked in → 14/14 pass. All three match the commit
message's claims exactly.

**F4 — merge-cleanliness: one trivial conflict, green after resolving it.**
Merging `origin/claude/hbc2js-tasks-a1cjkc` onto current `origin/main`
(`a72f7b5`) in a scratch worktree produces exactly one conflict, in the
append-only `docs/AGENT-LOG.md` (both sides appended distinct rows at the same
position — trivial "keep both" resolution, no semantic conflict). Every other
touched file (`docs/LOWERING-CATALOGUE.md`, `docs/TASKS.md`,
`docs/lowering/{generators,async-await}.md`, `docs/reviews/ARCH-2026-08-30.md`,
both test files) applies cleanly. After resolving the log conflict and
symlinking `tools/hermesc`: `npm test` → **871 pass, 0 fail, 1 skipped**, ~89s.
(The orchestrator will hit the same one-line log conflict on the real merge —
expected and easy, not a defect in the PR.)

**F5 — licence/provenance clean.** No PR commit touches `src/**`; nothing
resembling hermes-dec (AGPL) source appears anywhere in the diff — T13's
evidence is entirely `hbc2js disasm` output on committed fixtures compiled with
the pinned `hermesc` binaries, oracle-only per D4. `docs/AGENT-LOG.md` carries a
line for both the #6 fix and T13 (both attributed to Claude Opus 5, architect
session, 2026-08-30).

## Summary

T13's catalogue flips (rows 18/19, ⛔ → ✅ measured) and the #6 test-guard fix
both hold up against independent re-measurement and behavioural re-testing; the
branch merges onto current `main` with only a one-line, mechanical log conflict,
and the merged tree's `npm test` is green (871/0/1). No out-of-scope files were
actually touched by this PR (F1's apparent diff noise is `main` having moved,
not the PR). Recommend merge.
