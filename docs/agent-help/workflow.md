# Workflow: read before write

The loop every hbc2js agent session runs, in order:

1. **Orient.** `get_context(fn)` for the function (or `get_module(module)`
   for a whole module) you were pointed at. This gives source, summary,
   xrefs and strings in one call -- almost always enough to start.
2. **Widen if the context is thin.** `who_calls(fn)` / `calls_from(fn)` to
   see how the function is used from outside itself; `search_functions` /
   `search_source` when you need to find something by name or by a string
   it references, rather than by index.
3. **Propose, from evidence you actually have.** `suggest_names` for
   bindings you can justify from what you read; `rewrite_function` for a
   clearer restatement of a body (only after you understand what it does,
   never as a guess); `file_op` for a tree-level rename/move/combine/split.
   Every one of these writes a `suggested` record or a gated transaction --
   never a final answer.
4. **Abstain when the evidence is thin.** Writing nothing is a correct,
   expected outcome. Do not invent a name or a rewrite to have something to
   show; a wrong suggestion costs a human reviewer more than an empty
   reply.
5. **Stop. Never promote your own work.** `promote_change` and `promote`
   are for a human (the UI) or an opt-in evaluator, never for the agent
   that made the suggestion -- `promote_change` refuses a `worker:` who
   structurally, not just by convention. `list_suggestions` is how a
   reviewer (or a separate evaluator pass) finds what you proposed; you do
   not call it to approve yourself.

Nothing is canonical until promoted: a `suggested` name, an unpromoted
rewrite transaction, and an un-adopted file op are all still just proposals
sitting next to the faithful original, which never moves.
