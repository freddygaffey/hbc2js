# hbc2js — instructions for AI contributors

If you are on the `deb` box (or any fresh machine resuming this project), read `docs/RESUME-ON-DEB.md` first and prompt the user to start the loop. Otherwise read `docs/AGENT-BRIEF.md` first (one page). Open other docs only when your task needs them — your brief will name them. For architecture work read `docs/DECISIONS.md` too.

Hard rules:
- **Never copy code from hermes-dec** (AGPL). It is a behaviour oracle only. Derive opcode tables from the MIT-licensed Hermes repo (`include/hermes/BCGen/HBC/BytecodeList.def`) or from observation.
- Every change ships with tests and with the docs it affects, in the same commit.
- **Every bug fix ships with a regression test that fails before the fix and passes after.** If the bug was in decompilation semantics, that test is a new construct fixture (`tests/fixtures/constructs/`, compiled for every version via `build.sh`) plus, where it came from a real bundle, a test on that bundle's function. Name the test after the review/issue that found it. If a test is genuinely not yet possible, record the bug in `docs/BUGS.md` in the same commit — a bug is never fixed silently and never left undocumented.
- Must work on macOS and Linux; avoid platform-specific paths/binaries in core code.
- Append a line to `docs/AGENT-LOG.md` when you finish a task: date, model, task, outcome, cost note if known.
- Update `docs/STATUS.md` if you changed what works.

Testing rules (docs/CONSOLIDATION.md §B, items 7–10):
- **No exact-output assertions on shared fixtures.** A rung test asserts rung-owned properties (counts, structural checks, regex on the diff) or uses a rung-private fixture — never a literal-string/template comparison against the whole decompiled output of a fixture under `tests/fixtures/constructs/**`. Known design debt: every new rung used to break the previous rungs' string assertions. Enforced like `tests/gate/passes/imports.test.ts`, in `tests/gate/docs/testing-rules.test.ts`.
- **Who writes tests.** The spec agent writes the *acceptance* tests, shipped with the spec before implementation. Implementers may add regression tests — the "every bug fix ships a test" rule above requires it — but every `tests/` diff is listed in the landing report and reviewed. Test count must never drop; `tests/gate/docs/test-count.test.ts` checks it against `docs/test-count-baseline.json`.
- **Golden/snapshot regeneration needs Fred's approval, reviewed as a batch.** The orchestrator queues regenerations; never regenerate one inside an implementation task.
- **No fixture leaves the gate without a `docs/BUGS.md` row and an owner.** Exclusion tables (e.g. in `src/harness/tiers.ts`) are debt — every entry must cite a BUGS.md row. Enforced in `tests/gate/docs/testing-rules.test.ts`.
