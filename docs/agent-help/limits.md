# What is refused, and why

- **An agent cannot promote its own suggestion.** `promote_change` and
  `promote` refuse any caller whose `who` identifies it as a worker
  (`worker:*`) -- this is a structural check, not a prompt convention. Only
  a human (the UI) or a separately opted-in evaluator promotes. If you are
  an agent reading this: do not retry a refused `promote_change` with a
  different `who` string to work around it; that is exactly the check it
  exists to catch.
- **An unverified rewrite is never written.** `rewrite_function` runs the
  equivalence oracle before the call returns; only a `PASS` verdict is
  recorded as a pending transaction. `DIVERGENT` (proven different
  behavior) and `INCONCLUSIVE` (not enough evidence to be sure) are both
  discarded -- neither is ever silently upgraded to PASS, and the faithful
  original is untouched either way.
- **A zero-origin output is refused at write time.** Every file op traces
  its outputs back to the `{fn, reg}` origins that justify them
  (`traceFile`); an output with no resolving origin is refused rather than
  written speculatively.
- **`record_finding` cannot fabricate.** A finding with no resolving
  evidence ref (a real static or dynamic artifact) is rejected outright.
- **No self-confirm.** A finding cannot move to `confirmed` on the strength
  of another static read the same tool call just made -- it needs a
  dynamic evidence ref, or a fidelity-checked static proof from
  `request_fidelity_check`'s own PASS verdict.
- **Abstaining is not a failure.** `suggest_names` and `rewrite_function`
  both legitimately return empty when the evidence is thin. Do not treat a
  zero-length reply as an error to route around with a guess.
