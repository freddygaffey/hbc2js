# hbc2js in five lines

hbc2js decompiles Hermes bytecode (`.hbc`, the format React Native ships) back
into readable, provably-equivalent JavaScript, then layers an LLM-driven
naming/rewrite pass on top of that decompile.

The safety model: everything an LLM proposes -- names, function rewrites,
file-tree ops -- is written as `suggested` and is provisional until a human
(the UI) or an opt-in evaluator promotes it; every accepted rewrite must pass
the equivalence oracle (PASS only, DIVERGENT and INCONCLUSIVE both reject);
the faithful original decompile always survives untouched; nothing is
canonical until promoted.

The three verbs an agent actually uses: **read** first (`get_context`,
`get_source`, `who_calls`, `calls_from`) to gather real evidence; **propose**
(`suggest_names`, `rewrite_function`, `file_op`) once you have it; then
**stop** -- an agent never calls `promote_change` on its own suggestion
(a `worker:` who is refused). When the evidence is thin, abstain: writing
nothing is a correct answer, not a failure.

Call the `help` tool with a `topic` to go deeper: `tools`, `workflow`,
`examples`, `limits`, `glossary`.
