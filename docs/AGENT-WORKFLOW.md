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

M5 pass ladder flow
- A one-time ladder-architecture doc (`docs/specs/passes/00-LADDER.md`, strongest model) fixes rung order, dependencies, IR-node ownership and which rungs are hard. Passes are then specced in batches of five by the architect (Opus; the strongest model only for hard rungs) (`docs/specs/passes/NN-<name>.md`: match conditions from the catalogue row, rewrite output, check obligations, fixtures, acceptance), implemented one per Sonnet agent against its spec, reviewed briefly by a stronger model before the next pass builds on it. The gate (501/501 with passes on) is the regression bar for every pass.

## Lean agent type (token discipline, 2026-09-01)

Every hbc2js agent launches as the `lean` custom agent type (`.claude/agents/lean.md`, gitignored — recreate from this block on a fresh machine). Rationale: an agent's whole context is re-sent on every tool call, so cost = base context × turns. `general-purpose` inherits ~70 MCP tool schemas (Figma, Chrome, Gmail…) in that base; `lean` has only `Bash, Read, Edit, Write, Grep, Glob`. Target: ≤ ~40 tool calls / ~100k tokens per agent; batch shell commands; read only named files; full gate once; stop at ~80% budget with a handoff.

```
---
name: lean
description: Lean hbc2js worker — minimal tool set so the per-turn context base is small.
tools: Bash, Read, Edit, Write, Grep, Glob
---
(system prompt: the token-discipline rules above)
```
Briefs state the budget explicitly. Measured baseline before this change (2026-08-31/09-01, general-purpose): 130k–330k tokens and 90–170 tool calls per rung.

**Caveat (2026-09-01):** custom agent types under `.claude/agents/` are loaded at session start — a definition created mid-session is not available until the next `claude` launch (`Agent type 'lean' not found`). Until then, launch `general-purpose` with the budget rules pasted into the brief; the tool-schema saving only arrives with `lean`.
