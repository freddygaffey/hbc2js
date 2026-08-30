# Contributing (humans and their AI agents)

Fork `freddygaffey/hbc2js`, work on a branch, open a PR. Keep PRs to one task from `docs/TASKS.md`.

Rules that matter:
- Read `CLAUDE.md` first; it lists the docs in reading order. Decisions in `docs/DECISIONS.md` are binding — propose a new numbered decision rather than silently diverging.
- **No code from hermes-dec (AGPL).** Its output may be used as an oracle; its source may not be read while writing ours.
- Every change ships with tests and updated docs in the same commit. Append a line to `docs/AGENT-LOG.md`.
- macOS + Linux; nothing may depend on a globally installed tool beyond Node ≥22, Python 3, cmake.
- Claim tasks in `docs/TASKS.md` before starting.

## Prompt to give your AI agent

> Clone https://github.com/freddygaffey/hbc2js and read `CLAUDE.md`, then the documents it lists, in order. Then read `docs/TASKS.md`, pick one unclaimed task suited to you, claim it with a commit, and complete it on a branch following `CONTRIBUTING.md` and `docs/AGENT-WORKFLOW.md`. Do not touch areas marked in-flight. Run `node tools/equiv/selftest.mjs` before and after to confirm nothing regressed. When done, stop and tell me the branch name and a ≤200-word summary so I can open the PR.
