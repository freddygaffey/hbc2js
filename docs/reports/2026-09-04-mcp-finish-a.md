# 2026-09-04 — MCP finish A: leads/search/scan/package-id (lean Sonnet)

149k tokens (over budget), 80 calls. Commit 7134a97, gate 2073/0 foreground.

- src/mcp/leads.ts: leads()/securitySinks() enumerate security-decision sites (verify/sign/decrypt/keychain/async-storage/webview/crypto/deep-link/eval) from native surface + string xrefs + global reads, grouped by class (cap 20/class), evidence in fn:/sid: vocab record_finding resolves.
- searchFunctions()/searchSource(): paginated (cursor), capped (50/page, 20k-fn bound) — typed replacement for the cut query. + service.listFns().
- package-id WIRED: async, offline deps match+guess pipeline -> spec-13 two-key gate -> real {package,version,tier,evidence} or honest available:false. Stub gone.
- scan/deps (matchOsv vs offline slice), scan/secrets (SecretsService.scan, capped), scan/semgrep honest available:false (Lane S). FILED GAP: SecretsService is JSONL-only (reads index/strings.json off disk, no DB read path) -> scan/secrets available:false on .hbcproj; BUGS row.
- Remaining MCP: request_fidelity_check, recompile_edit, generate_documentation (action tools — next agent).
