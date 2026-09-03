# 2026-09-04 — MCP harness business-logic spec (lean Fable)

42k tokens, 8 calls. Commit (pending push), docs/specs/17-mcp-harness.md.

- BUSINESS LOGIC ONLY (fundamentals deferred to Fred per his ask). Resources: fn/source/context (composed token-saver), xref/*, native, module-graph, package-id (spec-13 two-key gate), annotations/findings/names/log/history, annotated-calls cross-store join — each pinned to a spec-10/11/16 verb's published cap.
- Tools: navigate/query (read); set_name/add_comment/add_tag/record_finding/set_finding_status/request_fidelity_check (writes via ProjectService logged path = 1 annotation append + 1 log row). record_finding needs resolving evidence; confirmed needs a dynamic ref; no self-confirm.
- Workflow: pick target -> one cheap context/{fn} read -> enrich -> record_finding (open+evidence) -> resolve/refute via fidelity check -> move on. Auditable via log?who={run}.
- Decision-8: 0 unsourced/over-cap/self-confirmed; tokens/step <=1.0x CLI (context/{fn} replaces >=3 calls); scripted task in a fixed budget on rn-template; held-out react-navigation. A1-A6.
- DEFERRED TO FRED (§6): transport/protocol, process/lifecycle, concurrency/single-writer, authN/Z, deployment/isolation, framework/packaging.
- 5 open questions -> review gate.
