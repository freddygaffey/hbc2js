# Readability layer -- the rewrite gate (spec 28, landing 2)

The readability layer lets a model (or another agent, or you) propose a
**rewrite** of one decompiled function: rename the locals, restate a lowered
state machine as the `for` loop it came from, collapse the temps the compiler
introduced. What makes that safe is not the model. It is this gate.

**The single guarantee.** A rewrite is kept only if
`hbc2js equiv --hbc <bundle.hbc> <rewrite.js>` says the program still behaves
exactly as the bytecode does. Anything else -- a rewrite that does not parse, a
rewrite that changes a result, a rewrite the oracle could not prove either way
-- is discarded, and the faithful decompile is what you keep. The faithful
render is never edited in place; a candidate only ever lives in a temp file for
the length of the oracle run.

`--code <candidate.js>` is read from a file, so this verb never picks a model
backend itself -- whoever produced the candidate (a human, another agent, or
`hbc2js name llm-fill`/`tools/readability/record.ts`, both of which default to
`--backend claude-cli`: spec 28 section 9.1, Fred's 2026-09-11 ruling to run on
the Claude plan through the CLI rather than the metered API) is irrelevant to
the gate below, which only ever asks the equivalence oracle.

## Using it

```
hbc2js readability rewrite <input.hbc> --fn N --code <candidate.js> \
    [--evidence "<why>"] [--out <sidecar.json>] [--out-js <file>] [--fuzz N] [--json]
```

- `--fn N` is the function index the candidate replaces.
- `--code <candidate.js>` holds the candidate: **exactly one**
  `function _fnN(...) { ... }` declaration and nothing else. `_fnN` is the name
  the emitter gives function `N`.
- `--out-js` writes the whole module render with the rewrite spliced in --
  only when the rewrite is accepted.
- `--out` writes the change record (below).
- Exit status: `0` accepted, `1` rejected, `2` usage.

Rejections print the class and leave everything alone:

| verdict | what happened |
| --- | --- |
| `ACCEPTED` | the oracle said PASS; the record is written with its proof |
| `REJECTED_PARSE` | the candidate, or the module with it spliced in, is not valid JavaScript. The oracle never runs |
| `REJECTED_SHAPE` | valid JavaScript, but not a single `function _fnN` declaration, or the faithful function could not be located unambiguously |
| `REJECTED_DIVERGENT` | the oracle proved the behaviour differs |
| `REJECTED_INCONCLUSIVE` | the oracle could not prove anything: no Hermes VM for that bytecode version, no output observed, or coverage too thin. INCONCLUSIVE is never PASS |

## What the oracle actually checks (spec 28 section 9.4, REWRITE row)

Two legs, and the weaker one can only ever lower the verdict.

1. **`module-hbc`** -- the Hermes VM runs the original bytecode, the same VM
   runs the module with your rewrite spliced in, and the printed output is
   compared. This is the guarantee. The rewrite is *restricted to the affected
   function* in the literal sense: the spliced render is byte-identical to the
   faithful one outside that one function's span, so the only thing that can
   move the verdict is the rewrite.
2. **`function-fuzz`** -- when the module's own run observed only a couple of
   output lines (thin trace coverage), the faithful function and the rewritten
   one are also driven differentially over the seeded fuzz corpus (spec 09),
   each as the only global of its own program, and every call must agree. If
   every fuzzed call throws on both sides, nothing was observed and the verdict
   is INCONCLUSIVE -- "both sides broke identically" is not evidence.

Both legs are callable as a library (`src/harness/hbc-equiv.ts`:
`hbcVsJsUnderHermes`, `runFunctionEquiv`), which is what the gate uses; the CLI
is a thin wrapper over the same code.

## What an accepted rewrite is stored as

A `suggested` change record (`RewriteChangeRecord` in
`src/readability/rewrite.ts`), spec 28 section 9.5's transaction shape:

- `who` / `tier` / `ts` -- provenance. A worker writes `tier: "suggested"` and
  never promotes its own work; a human or a reviewer promotes.
- `inputs` / `outputs` -- the bytecode origins the code derives from. An output
  with no origin is an orphan and invalidates the record.
- `equiv` -- the `EquivProof`: verdict, the **verbatim** oracle invocation, and
  the coverage (`inputs` fuzzed, `records` compared) it rests on. Read the
  coverage: a PASS proven over 8 output lines is weaker than one proven over
  8 lines plus 50 fuzzed calls, and the proof says which you have.
- `prior` -- the sha256 of the faithful render it replaced, so a revert is
  exact.

Landing 3 turns these records into rows of the transaction log; until then they
are returned in memory or written to the `--out` JSON sidecar, which is derived
data (rebuildable, never authoritative).

## Writing a candidate a gate will accept

There is no skill file for rewrites yet (docs/PUSHBACK.md P-57 says why); this
is the contract a prompt or a human should follow.

- Emit exactly one `function _fnN(...) { ... }` declaration, same name, same
  parameter count. Nothing before it, nothing after it.
- Change only what makes it readable: local names, loop form, redundant temps,
  obvious re-association. Never change what is printed, thrown, returned, or
  in what order.
- Do not touch property keys, globals, or anything reached by a string --
  those are outside the rename domain (spec 28 section 0a rule 1) and will
  either be refused or diverge.
- Prefer a conservative rewrite where the function is barely exercised. Thin
  coverage means the oracle has less to prove with, and an unprovable rewrite
  is rejected exactly like a wrong one.
- Say why in the evidence field. A rewrite with no stated reason is still
  gated, but a reviewer has nothing to judge its *quality* by, and quality is
  the half the oracle cannot check.

## File operations and the transaction log (landing 3)

Readability is not only within a function: the tool may reshape the file tree.
Five ops, each one an equiv-gated, DB-recorded transaction
(`src/readability/file-ops.ts`):

| op | what it does |
| --- | --- |
| `make` | create a new file (extract a component/hook/util into its own file) |
| `rename` | give a file a meaningful name in the SAME directory |
| `move` | put a file in a different directory |
| `combine` | merge modules that are really one unit into one file |
| `split` | break a mega-module into several readable files |

`rename` and `move` are deliberately distinct: passing a cross-directory `to`
to `rename` is an error, and so is a same-directory `to` on `move`. The log
then says what actually happened.

**The gate has two legs and both must pass before anything is written.**

1. **Structure**, in process, no VM: the require graph resolves identically
   (every module id still has a file, every dependency id still resolves) and
   the export surface is preserved. The export leg applies to the ops that
   MOVE code -- a `make` adds a file nothing requires yet, so its exports
   cannot change how an existing module resolves.
2. **Behaviour**: `hbc2js equiv --hbc <bundle.hbc> <tree/>` over the tree's
   entry, verdict PASS. DIVERGENT and INCONCLUSIVE both reject; INCONCLUSIVE
   is never PASS, so forgetting the bundle is a refusal, not a free pass.

The op is staged into a temporary copy of the tree and judged there. On a
rejection the real tree is **byte-for-byte untouched**, nothing reaches the
DB, and the attempt comes back with the oracle's verdict and reason so a human
can see what was tried and refused.

## Reverting a change

Every accepted change -- name, rewrite, file op -- is a row in the readability
transaction log (`analysis/readability/<id>.json`, spec 28 section 9.5). Each
row records the `prior` state of every path it touched, as a sha256, and the
DB holds those exact bytes. So:

- **Revert is exact.** `revertTransaction(db, projectDir, treeDir, txId, who)`
  puts every prior path back to exactly its recorded hash and removes anything
  the transaction created that had no prior state.
- **A revert is itself a transaction**, so the undo is auditable and
  **reverting the revert redoes the original change**, byte for byte.
- **A transaction is never reverted twice**; the second attempt is refused.
- **A transaction that cannot be reverted is never recorded.** An output with
  no binding origin, an op with no prior state, a proof that is not PASS, a
  worker writing `tier: confirmed`, or prior content that does not hash to
  what the transaction claims -- all are refused *before* the DB, the shard or
  the log is touched.

`traceFile(db, path)` walks the other direction: from a path in the readable
tree back through `EmittedFile.origins -> BindingOrigin -> module index ->
{fn,reg}` to the bytecode it came from, however many combines and splits
happened in between. `traceAllEmitted(db)` is the whole-tree version, and
"zero orphans" is that list with no `orphan: true`.

On the command line, `hbc2js hbcproj verify <project.hbcproj> --full`
re-validates every transaction's proof and origins alongside spec 18's own
round-trip validators.

## MCP tools and the suggestion pane (landing 4)

`src/readability/surfaces.ts` exposes the seven tools spec 28 section 9.7
pins (`READABILITY_MCP_TOOLS`) as plain functions over a `ReadabilityContext`
(`{db, projectDir, treeDir, backend, hbcPath?, oracle?, functionOracle?,
who?}`): `suggest_names`, `rewrite_function`, `classify_module`, `file_op`,
`promote_change`, `revert_change`, `list_suggestions`. `src/mcp/tools.ts`'s
`registerReadabilityTools(ctx)` wraps each one with JSON-schema argument
validation (`READABILITY_TOOL_SCHEMAS`) so a malformed call from an external
agent never reaches `surfaces.ts` at all -- "an external agent gets exactly
the UI's safety" (section 9.7). `promote_change`/`revert_change` are
deliberately NOT `promote`/`revert`: those names already exist on the spec-17
MCP surface with a different argument shape (name-overlay promotion), and
`surfaces-evaluator.test.ts` asserts the two vocabularies never collide.

`promote_change` refuses any `who` starting with `worker:` -- only a human or
an opt-in evaluator (landing 5) may promote (section 1d) -- and
`revert_change` is exact and byte-for-byte (section 9.5's guarantee), same as
the CLI/direct-`transactions.ts` path above.

**Known gap (docs/PUSHBACK.md P-59, open)**: `suggest_names` and
`classify_module` do NOT write into the `readability_tx` table `rewrite`/
`file_op` use. That table's `EmittedFile.path` is a real path under `treeDir`
(a revert writes bytes straight to it), and a NAME/classification proposal
has no tree file yet at the point these two tools run -- they operate on a
fresh decompile, the same stage landing 1's CLI pass does. Both are still
equiv-verified (the section 9.4 NAME-row backstop, run once per batch) and
reviewable (the name-overlay's own supersession chain, `NameRecord.rid`), but
their `txIds`/`txId` come back empty/`undefined`, and `list_suggestions`
currently only lists rewrite/file-op transactions. `rewrite_function` and
`file_op` have no such gap: both materialise their accepted output into
`treeDir` before recording, so a later revert has real bytes to restore.

The suggestion pane's evidence/confidence/equiv-status columns, the
before/after diff, and the batch promote/revert filters (tier, confidence,
module, security-relevant) are this landing's open UI follow-up -- not yet
wired by this agent, queued next.
