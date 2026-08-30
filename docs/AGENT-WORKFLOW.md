# How work gets done here

1. **Architect agent (Opus)** turns a milestone in `docs/STATUS.md` into a spec under `docs/specs/<component>.md`: interfaces, data structures, invariants, test plan, acceptance criteria. No code.
2. **Implementation agent (Opus or Sonnet per D5)** implements exactly that spec, with tests, in a branch or worktree. It must run the full test suite before reporting.
3. **Overseer (Fable)** reviews the diff and test output, merges, updates `docs/STATUS.md`, commits, pushes.
4. **Every agent** appends to `docs/AGENT-LOG.md`.

Conventions
- `src/` TypeScript, ESM, strict. `tests/` uses Node's built-in test runner (`node --test`) to keep deps minimal.
- CLI entry: `hbc2js <input.hbc> [output.js]`.
- Fixtures: `tests/fixtures/<name>/{source.js,vNN.hbc,licence.txt}` — keep source and every compiled version together.
- Commit messages: imperative, one component per commit where possible.
