# Every MCP tool hbc2js serves

One line per tool: purpose, arguments, and a worked call/reply. Names match
the tool table exactly (`tests/mcp/help.test.ts` checks this file against
`src/mcp/server.ts` in both directions, so a tool cannot rot out of sync
with this list). Read-only tools first, then the spec-17 write/annotate
tools, then the spec-28 readability tools.

## General

- `help`: read these docs from inside a session. Args: `{topic?: string}`
  (one of tldr|tools|workflow|examples|limits|glossary; omit for the tldr
  plus this topic list). Example: call `{}` -> reply is the tldr text;
  call `{"topic": "workflow"}` -> reply is this file's sibling.

## Read tools (spec 17, section 1) -- call these before any write

- `get_context`: scoped decompiled context for one function (source,
  summary, xrefs, strings) -- the same shape the UI's context pane reads.
  Args: `{fn: number}`. Example: call `{"fn": 188}` -> reply
  `{fn: 188, source: "function f(...){...}", summary: "...", xrefs: [...]}`.
- `get_source`: decompiled source of one function. Args: `{fn: number}`.
  Example: call `{"fn": 188}` -> reply `{fn: 188, source: "..."}`.
- `get_disasm`: disassembly of one function. Args: `{fn: number}`. Example:
  call `{"fn": 188}` -> reply `{fn: 188, disasm: "..."}`.
- `who_calls`: callers of one function. Args: `{fn: number}`. Example: call
  `{"fn": 188}` -> reply `{fn: 188, callers: [12, 45]}`.
- `calls_from`: callees of one function. Args: `{fn: number}`. Example: call
  `{"fn": 188}` -> reply `{fn: 188, callees: [201]}`.
- `search_functions`: search function names/signatures by substring. Args:
  `{query: string}`. Example: call `{"query": "fetch"}` -> reply
  `{matches: [{fn: 12, name: "fetchUser"}]}`.
- `search_source`: search decompiled source text by substring. Args:
  `{query: string}`. Example: call `{"query": "AsyncStorage"}` -> reply
  `{matches: [{fn: 40, line: 3}]}`.
- `get_module`: module summary by id: its functions and their names. Args:
  `{module: number}`. Example: call `{"module": 3}` -> reply
  `{module: 3, functions: [{fn: 188, name: "f188"}]}`.

## Write / annotate tools (spec 17) -- logged, evidence-checked

- `set_name`: set a name for a binding (`fn:N` or `reg:N:R`). Args: the
  spec-17 `SetNameInput` (target, name, provenance). Example: call
  `{"target": "fn:188", "name": "fetchUserProfile", "prov": {...}}` ->
  reply `{ok: true}`.
- `add_comment`: add a comment to a target. Args: `AddCommentInput`.
  Example: call `{"target": "fn:188", "text": "guards a null token"}` ->
  reply `{ok: true}`.
- `add_tag`: add a tag to a target. Args: `AddTagInput`. Example: call
  `{"target": "fn:188", "tag": "network"}` -> reply `{ok: true}`.
- `record_finding`: record a finding; rejected with no resolving evidence
  ref. Args: `RecordFindingInput`. Example: call
  `{"target": "fn:188", "evidence": ["fuzz:..."], ...}` -> reply
  `{findingId: "..."}`.
- `set_finding_status`: advance a finding's status; never self-confirming.
  Args: `SetFindingStatusInput`. Example: call
  `{"findingId": "...", "status": "confirmed", ...}` -> reply `{ok: true}`.
- `request_fidelity_check`: run the oracle ladder over one function's
  decompiled source and return evidence (writes nothing). Args:
  `RequestFidelityCheckInput`. Example: call `{"fn": 188}` -> reply
  `{verdict: "PASS", detail: {...}}`.
- `recompile_edit`: compile an edited function's source with the project's
  matching `hermesc` to a SCRATCH `.hbc` copy -- never the original bundle.
  Args: `RecompileEditInput`. Example: call `{"fn": 188, "source": "..."}`
  -> reply `{outPath: "...", kind: "edited-and-recompiled"}`.
- `generate_documentation`: render a report from this session's own
  log/findings; deterministic, writes nothing. Args:
  `GenerateDocumentationInput`. Example: call `{}` -> reply
  `{report: "..."}`.
- `promote`: promote a `suggested` name (spec-17's own naming system) to
  accepted. Args: `PromoteInput`. Example: call `{"target": "fn:188"}` ->
  reply `{ok: true}`.

## Readability tools (spec 28, section 9.7) -- suggestions only, never final

- `suggest_names`: propose names for one function's or one register's
  bindings from real evidence; written as `tier: "suggested"`. Args:
  `{target: {fn: number} | {module: number}, budgetTokens?: number,
  evaluate?: string}`. Example: call `{"target": {"fn": 188}}` -> reply
  `{suggestionIds: ["s1"], names: [{bindingId: "reg:188:2",
  name: "userId"}]}` (or `{names: []}` when the evidence is thin --
  abstaining is correct, see `limits`).
- `rewrite_function`: propose a clearer restatement of one function's body,
  equivalence-gated before it is ever recorded. Args: `{fn: number,
  budgetTokens?: number, evaluate?: string}`. Example: call `{"fn": 188}`
  -> reply `{txId: "t1", verdict: "PASS"}` or a rejection with `verdict:
  "DIVERGENT"` / `"INCONCLUSIVE"` (both discarded, never written).
- `classify_module`: classify one module (src vs vendored/node_modules-like)
  from evidence. Args: `{module: number, evaluate?: string}`. Example: call
  `{"module": 3}` -> reply `{module: 3, classification: "src"}`.
- `file_op`: propose a file-tree operation (make/rename/move/combine/split)
  with the tree-level equivalence gate. Args: `{op: string, inputs?:
  object, outputs?: object, evidence: string}`. Example: call
  `{"op": "rename", "inputs": {"path": "a.js"}, "outputs":
  {"path": "userProfile.js"}, "evidence": "fn:188 calls it a profile"}` ->
  reply `{txId: "t2", verdict: "PASS"}`.
- `promote_change`: promote a suggested name or a rewrite/file-op
  transaction to accepted; refuses a `worker:` who. Args: `{txId?: string,
  suggestionId?: string, who: string}`. Example (from an agent's own
  `who`): call `{"suggestionId": "s1", "who": "worker:haiku"}` -> reply is
  a refusal, `isError: true` (see `limits`).
- `revert_change`: revert a promoted or suggested change back out; itself a
  logged transaction. Args: `{txId?: string, suggestionId?: string}`.
  Example: call `{"txId": "t2"}` -> reply `{ok: true, revertedTxId: "t2"}`.
- `list_suggestions`: list pending/promoted suggestions and transactions
  for review. Args: `{filter?: object, limit?: number}`. Example: call
  `{"limit": 20}` -> reply `{suggestions: [...], transactions: [...]}`.
