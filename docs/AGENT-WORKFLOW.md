# How work gets done here

1. **Architect agent (Opus)** turns a milestone in `docs/STATUS.md` into a spec under `docs/specs/<component>.md`: interfaces, data structures, invariants, test plan, acceptance criteria. No code.
1b. **Adversarial spec review (Sonnet)** reads the spec against the format docs, fixtures and decisions and returns findings: gaps, contradictions, untestable criteria, ambiguities an implementer could misread. The architect fixes them before any code is written.
2. **Implementation agent (Opus or Sonnet per D5)** implements exactly that spec, with tests, in a branch or worktree. It must run the full test suite before reporting.
3. **Overseer (Fable)** reviews the diff and test output, merges, updates `docs/STATUS.md`, commits, pushes.
4. **Every agent** appends to `docs/AGENT-LOG.md`.

Conventions
- `src/` TypeScript, ESM, strict. `tests/` uses Node's built-in test runner (`node --test`) to keep deps minimal.
- CLI entry: `hbc2js <input.hbc> [output.js]`.
- Fixtures: `tests/fixtures/<name>/{source.js,vNN.hbc,licence.txt}` — keep source and every compiled version together.
- Commit messages: imperative, one component per commit where possible.

Orchestrator hygiene
- The overseer never reads agent transcripts, source dumps, or long docs. Agents report in ≤300 words; anything larger goes in a file under `docs/` and the report links to it.
- Diff review of implementation work is delegated to a reviewer agent that returns pass/fail + findings; the overseer reads the verdict only.
- Rationale: the overseer's context is the project's scarcest resource.
- **Don't resume large-context agents for follow-ups.** Every turn of a resumed agent re-reads its entire context (cached, but billed). For fixes and follow-up work, launch a fresh agent with a tight brief that points at the review or status doc; resume only when the agent's context is small or the remaining step is trivial. Prefer many small briefs over one long-lived agent.

Bug rule
- A bug found by a review, a sweep, or a user gets a regression test in the same commit as its fix — one that reproduces the bug (fails on the pre-fix commit) and is named after its source (e.g. `review-M4-C1-catch-finally-order`). Semantic bugs also get a construct fixture so every version is covered from then on.

Brief hygiene
- Briefs put the facts the agent needs *inline* (numbers, file paths, the exact bug) and name at most the 2–3 files the task touches. `docs/AGENT-BRIEF.md` is the only mandatory read. Don't send agents on reading tours; tokens spent orienting are tokens not spent working.
