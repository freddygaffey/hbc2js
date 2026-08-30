# hbc2js — instructions for AI contributors

Read in this order before doing anything: `SPEC.md` → `docs/RESEARCH-SUMMARY.md` → `docs/DECISIONS.md` → `docs/AGENT-WORKFLOW.md` → `docs/STATUS.md`.

Hard rules:
- **Never copy code from hermes-dec** (AGPL). It is a behaviour oracle only. Derive opcode tables from the MIT-licensed Hermes repo (`include/hermes/BCGen/HBC/BytecodeList.def`) or from observation.
- Every change ships with tests and with the docs it affects, in the same commit.
- Must work on macOS and Linux; avoid platform-specific paths/binaries in core code.
- Append a line to `docs/AGENT-LOG.md` when you finish a task: date, model, task, outcome, cost note if known.
- Update `docs/STATUS.md` if you changed what works.
