# Glossary

- **fn**: a function index into the decompiled bundle -- the unit most read
  tools and both readability write tools (`suggest_names`,
  `rewrite_function`) address. Stable across a run; not a line number.
- **reg**: a Hermes VM register within one function; a naming target below
  function granularity is `reg:N:R` (function N, register R).
- **bindingId**: the addressable key a suggested name attaches to --
  `fn:N` or `reg:N:R` -- returned by `suggest_names` and consumed by
  `promote_change`/`list_suggestions`.
- **module**: one CommonJS module in the split bundle (Metro's `__d()`
  units), the granularity `get_module`, `classify_module` and the `combine`
  file op work over.
- **tier**: a name or suggestion's trust level -- `suggested` (LLM
  proposal, not yet reviewed) vs promoted/accepted (a human or opt-in
  evaluator signed off). Nothing is canonical below promoted.
- **equiv**: the equivalence oracle a rewrite or file op must PASS before
  it is ever recorded -- runs the decompiled result against the original
  bytecode under the Hermes VM (and a fuzz leg when trace coverage is
  thin). Verdicts are PASS / DIVERGENT / INCONCLUSIVE; only PASS lands, and
  INCONCLUSIVE is never treated as PASS.
- **transaction**: a reversible, provenance-stamped record of one rewrite
  or file op (`txId`), distinct from a name suggestion (`suggestionId`) --
  two separate systems that both answer to "propose a change"; a
  transaction is what `revert_change` and `promote_change`'s `txId` field
  address.
