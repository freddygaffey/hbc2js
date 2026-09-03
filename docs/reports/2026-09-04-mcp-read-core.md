# 2026-09-04 — MCP read-resource core (lean Sonnet)

148k tokens (over budget — the session's persistent agent-overrun pattern), 109 calls. Commit ac19782. Gate 2004/0.

- src/mcp/resources.ts: McpResources, transport-agnostic (no MCP SDK binding) over ArtifactService+ProjectService. All read resources: fn/source/context(include+depth BFS, no double-fetch)/disasm; xref who-calls/calls-from/string(exact|substring|regex)/global-uses with inline {fn,name,size} per neighbor; module/native; annotations/findings/finding/log/history/annotated-calls. Caps from the services' published CAPS + LIMIT cap+1.
- Added service.ts stringsUsedBy(fn) + disasm(fn) (re-project existing rows, cached).
- 24 tests green; tests/mcp wired into gate globs (was omitted).
- DOCUMENTED GAPS (follow-ups): package-id/{mod} stubbed — should wire to tonight's sigdb (import/write-path exist) + deps package-id, agent didn't find the wiring; log/history/annotated-calls limited because ProjectService doesn't retain a DB handle (writes still land JSONL even for a .hbcproj project) — a step-3/4 follow-up.
- Construct fixtures have zero CJS modules -> empty ix_ranges -> source-emitting resources tested against rn-template instead (pre-existing limitation, routed around like existing tests).
- NEXT MCP: write tools (evidence-gated), lead-generators (leads/security-sinks, scan/*, search/*), recompile_edit, generate_documentation.
