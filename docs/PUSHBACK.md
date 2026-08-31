# Pushback ledger — agents disputing a spec, brief or decision

An implementation or design agent that believes its spec/brief is **wrong,
unsafe, or in conflict with a decision** (`docs/DECISIONS.md`) must not work
around it silently. It records the dispute here, commits the row, and says
`PUSHBACK P-nn` in its report. The overseer triages every open row each tick:

- **overseer** answers when the resolution is obvious;
- **Fred** decides when it is a design/priority call;
- a **short checker agent** verifies when it is a factual claim about bytecode
  or semantics (verdict: valid / invalid + why).

The resolution is written back into the spec's "Review responses" section
(the spec stays the single source of truth) and the row is closed here.
Never delete rows.

Meanwhile the agent does one of: `stopped` (default when the whole deliverable
depends on it), `as-specced` (implemented the spec as written, flagged), or
`alternative` (implemented a clearly-marked alternative — say which in the
commit message). Prefer `stopped` over guessing on anything semantic (D14).

| Id | Date | Agent (model, task) | Spec / doc | Claim | Evidence | Meanwhile | Status | Resolution |
|----|------|---------------------|------------|-------|----------|-----------|--------|------------|
