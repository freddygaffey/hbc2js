# 2026-09-03 — harness D14-override generalization + mutation gating + message masking (lean Sonnet)

154k tokens (over budget — briefs still too big, splitting further next time), 110 tool calls, ~17 min. Commit 9df271a.

- D14 override now EVIDENCE-BASED: vmAgreesEvidence (VM actually ran; candidatePrint === hermesPrint) gates the downgrade, not curated names; KNOWN_DIVERGENT_FIXTURES = fallback only when no VM ran; missing evidence NEVER downgrades.
- mutate/generate thread target HBC version, filter fixtures whose versions.txt FAILS it (no more classes -> v94 hermesc).
- Trace compare: identifier-token masking in error messages only, masked-only matches surfaced as a distinct caveat.
- Repro matrix: v94 3 DIV + 2 ERR -> 30/30 PASS; v99 -> 29/30, sole DIVERGENT = seed 777007 (the real open async bug). adversarial/20 v99 flipped PASS-with-caveat per its own prove-fixed criterion (README updated; underlying toolchain gap still open).
- 10 regression tests across 3 files. BUGS: 27 open / 34 resolved, ledger gate green.
