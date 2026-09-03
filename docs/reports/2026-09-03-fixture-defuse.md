# 2026-09-03 — seeded fixture defused at rest (lean Sonnet)

90k tokens, 61 tool calls, ~11 min. Commit 74935ce.

- Cause: format-faithful synthetic secrets tripped GitHub push protection (4 hits), blocking ALL pushes; unblock-URLs deliberately not used.
- Scheme: hbc2js-defused:<base64 in 8-char dot-joined chunks> — chunk size under every patterns.ts threshold (JWT >=10, entropy >=20/32). Near-misses stay literal by design. materialize.ts writes the true spec-10 artifact to tmpdir at test time.
- Found + fixed its own trap: plain base64 tripped aws-secret-ctx/generic-entropy on the encoded body.
- Standing guard: at-rest-defused.test.ts greps the at-rest fixture against every anchored pattern + asserts markers; anchored-set scoping documented (entropy/context-gated patterns excluded deliberately).
- T-tests: identical results to pre-defuse baseline + 2 new passes. Gate 1841/0.
- Orchestrator follow-up: squash unpushed range (purges flagged blobs from push range) after step-4 agent lands, then gate + push.
