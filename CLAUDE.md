# hbc2js — instructions for AI contributors

Read in this order before doing anything: `SPEC.md` → `docs/RESEARCH-SUMMARY.md` → `docs/DECISIONS.md` → `docs/AGENT-WORKFLOW.md` → `docs/STATUS.md`.

Hard rules:
- **Never copy code from hermes-dec** (AGPL). It is a behaviour oracle only. Derive opcode tables from the MIT-licensed Hermes repo (`include/hermes/BCGen/HBC/BytecodeList.def`) or from observation.
- Every change ships with tests and with the docs it affects, in the same commit.
- **Every bug fix ships with a regression test that fails before the fix and passes after.** If the bug was in decompilation semantics, that test is a new construct fixture (`tests/fixtures/constructs/`, compiled for every version via `build.sh`) plus, where it came from a real bundle, a test on that bundle's function. Name the test after the review/issue that found it. If a test is genuinely not yet possible, record the bug in `docs/BUGS.md` in the same commit — a bug is never fixed silently and never left undocumented.
- Must work on macOS and Linux; avoid platform-specific paths/binaries in core code.
- Append a line to `docs/AGENT-LOG.md` when you finish a task: date, model, task, outcome, cost note if known.
- Update `docs/STATUS.md` if you changed what works.
