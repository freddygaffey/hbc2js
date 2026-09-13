# Three end-to-end transcripts

## 1. Name a function's parameters

1. `get_context({fn: 188})` -> source shows a function with unnamed
   registers `reg:188:1`, `reg:188:2` used as a URL and a callback.
2. `who_calls({fn: 188})` -> called from a function whose own decompiled
   source builds a REST path before calling in -- confirms `reg:188:1` is
   a URL, not just "looks like one".
3. `suggest_names({target: {fn: 188}})` -> reply
   `{suggestionIds: ["s1"], names: [{bindingId: "reg:188:1", name: "url"},
   {bindingId: "reg:188:2", name: "onComplete"}]}`. Both are written as
   `tier: "suggested"` -- nothing renamed yet.
4. Stop. A human reviews with `list_suggestions` and promotes what looks
   right; the agent does not call `promote_change` itself.

## 2. Rewrite one function

1. `get_context({fn: 40})` -> a small function, faithful to the bytecode
   but written as a flat `if`/`else` chain with duplicated dereferences.
2. `get_disasm({fn: 40})` if the decompiled source alone leaves any control
   flow ambiguous (rare, but cheaper than guessing).
3. `rewrite_function({fn: 40})` -> the proposed body is spliced into the
   faithful render and run through the equivalence oracle before this call
   even returns. Reply `{txId: "t7", verdict: "PASS"}` means it is now a
   pending transaction, still not adopted. A `DIVERGENT` or `INCONCLUSIVE`
   verdict means the proposal was rejected and nothing was written --
   correct behavior, not a bug to route around.
4. Stop. `list_suggestions` surfaces `t7` for review; only a human or an
   opt-in evaluator calls `promote_change({txId: "t7", who: "..."})`.

## 3. Combine two files

1. `get_module` on each of the two module ids in question, plus
   `search_source` to confirm they are actually related (e.g. one small
   helper module only ever imported by the other).
2. `file_op({op: "combine", inputs: {modules: [12, 13]}, outputs:
   {path: "userProfile.js"}, evidence: "module 13 has one export, only
   imported by module 12"})` -> the tree-level equivalence gate runs before
   the call returns. Reply `{txId: "t9", verdict: "PASS"}`.
3. Stop. The combine is a pending transaction like any other file op;
   review and promotion happen the same way as example 2.
