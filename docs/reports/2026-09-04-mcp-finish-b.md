# 2026-09-04 — MCP finish B: action tools — MCP COMPLETE (lean Sonnet)

115k tokens (on budget), 50 calls. Commit 70fb6ea, gate 2081/0 foreground.

- requestFidelityCheck: wires runOracleLadder over one fn's candidate (default oracle syntax; not whole-module roundtrip); returns {verdict,oracles,evidence,detail}; evidence = {ref:"fn:N",role:"fidelity-checked"} iff PASS — the exact shape setFindingStatus's confirm gate accepts. Writes nothing. Tested: confirms a finding with the returned evidence.
- recompileEdit/recompileEditAndRun: compiles edited source with the project's tools/hermesc/vNN into a fresh mkdtemp scratch (NEVER the original bundle/.hbcproj — no-mutate byte-proven); every return carries the required WARNING + watermark {edited-and-recompiled, baseBundleSha256, fn, editSha256}; logs via ProjectService.addComment (1 annotation + 1 log row); runTrace executes + returns the edited trace.
- generateDocumentation: deterministic Markdown from log/findings + an in-process recompileActions record (log.detail is a fixed marker, so full edit source kept session-local, no schema change); two calls byte-identical.
- MCP BUSINESS-LOGIC SURFACE COMPLETE (read core + write tools + leads/search/scan + action tools). Fundamentals (transport/lifecycle/auth/deploy) still deferred to Fred.
