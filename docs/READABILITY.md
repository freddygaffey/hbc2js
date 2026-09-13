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

## Batch naming (`hbc2js name llm-fill`)

```
hbc2js name llm-fill <input.hbc> [--backend claude-cli|haiku|replay|heuristic|fake] \
    [--budget-tokens N] [--recording <file>] [--only src] [--store <path>] [--per-register] [--json]
```

Same defaults as `record.ts` above: one backend call per function
(`--per-register` reverts to one per `{fn,reg}`), `decompileFunction` for the
prompt source, and `--only src` genuinely restricts collection to
`computeSrcScope`'s src-bucket functions (fixed 2026-09-13 -- the flag was
documented in this verb's own usage string well before it was implemented;
without it, or before this fix, collection walks every function in the
bundle, which is what a real 43,384-function run hit -- 38 minutes at 16 GB
RSS, killed before the first model call, docs/BUGS.md 2026-09-11 residual
row). Progress prints to stderr (suppressed under `--json`, which is meant
for scripting): `collecting k/N function(s) (m target(s) so far)` during
collection (the phase that can itself run for minutes on a large bundle,
independent of any model call), then `target i/N: <label>` once per target
as `runNamePass` processes it, so a long real run against `--backend
claude-cli` is never silent. Final summary: `named X/Y targets (tokens T,
equiv VERDICT)` (or the same fields as JSON with `--json`).

## Recording (`tools/readability/record.ts`)

`tools/readability/record.ts` is the ONE tool in this layer that calls a real
model (spec 28 section 9.1) -- it produces the committed
`tests/fixtures/llm-readability/<app>.recording.json` a `ReplayBackend`
answers from, so the gate's coverage/quality legs (spec 28 section 7) run
against a held-out app without a live model in CI. It is never run by the
gate itself.

```
node tools/readability/record.ts <input.hbc> <output.recording.json> \
    [--limit N] [--backend claude-cli|haiku|fake] [--only src] \
    [--sample N [--seed S]] [--resume] [--per-register]
```

- **Default: one call per FUNCTION** (spec 28 section 9.1). Every nameable
  register a function still needs a name for is asked about in ONE backend
  call: the request's `context.targets` lists every one of them in the
  skill's `{fn,reg}` short form, and the reply's `names[]` (already an
  array, spec 28 section 9.1's wire contract) answers as many as the model
  has evidence for. On the held-out app's `--only src` population this cuts
  the recording from one call per `{fn,reg}` (31,298 calls) to one call per
  function (4,655 calls) -- a ~6.7x reduction in real model calls/tokens.
  `--limit`, `--resume` and the progress line all count FUNCTIONS in this
  mode. `--per-register` reverts to landing 1's original one-call-per-`{fn,
  reg}` shape (still used by `--per-register` on `name llm-fill` and by the
  UI's single-register `suggest_names` job, which never batches).
- The prompt source for BOTH modes is `decompileFunction`
  (`src/decompile.ts`'s scoped single-function render, docs/DECISIONS.md
  D-scoped-render), never `NameService.render({fn})` (BUGS 2026-09-11
  "render() is O(whole-bundle) per call" -- resolved by no longer calling it
  here at all). `decompileFunction` still re-parses and re-analyses the
  whole bundle on every call (cheaper than a whole-module structure+emit,
  but not free): measured on the held-out app with `--backend fake` (zero
  model latency), a `--sample 50` run took 48.2s (~0.96s/call), so a full
  non-sampled `--only src` recording still pays tens of minutes of pure
  parse+analysis before any real model latency -- tracked as its own
  follow-up (docs/BUGS.md, 2026-09-11, readability / render lane).
- `--only src` (default off): restrict targets to functions belonging to a
  module `src/readability/scope.ts`'s `computeSrcScope` classifies as `src`
  app code (the same `splitProject` -> `segregateSplitTree` path
  `hbc2js segregate` uses, spec 08) rather than `node_modules`/
  `unclassified` -- spec 28 section 7's coverage target is measured over
  exactly this population, not the whole bundle (~15k functions on the
  held-out app). Prints the selected module/function counts to stderr
  before the first model call.
- `--sample N [--seed S]` (default seed 1): a deterministic reservoir sample
  of N targets from the selected set, for a bounded, reproducible smoke run
  -- the same seed always samples the same targets; a different seed samples
  independently.
- `--resume`: if the output recording already exists, any target whose
  cache key is already a key in it answers from the existing file with zero
  backend calls (counted as a cache hit in the final aggregate) -- lets a
  rate-limited run continue without re-spending tokens.
- Progress prints to stderr per function-batch target as `fn N: k regs
  named / m requested (<in>/<out> tok, <s>s)` (default mode) or per
  register as `recorded k/N: fn<F> r<R> (<in>/<out> tok, <s>s)`
  (`--per-register`), and a final aggregate line (targets, calls, tokens
  in/out, seconds, cache hits) either way.

The held-out app's own recording (spec 28 section 10, landing 1) is produced
with:

```
node tools/readability/record.ts <held-out.hbc> \
    tests/fixtures/llm-readability/react-navigation-example-0.85.3.recording.json \
    --backend claude-cli --only src --resume
```

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

`skills/hbc-name.md`'s `## Rewrite` section (`version: 2`, docs/PUSHBACK.md
P-57, resolved) is the prompt contract; this is the same rule for a prompt
or a human writing a candidate by hand.

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

**Names are overlay transactions (docs/PUSHBACK.md P-59, resolved).**
`suggest_names` does NOT write into the `readability_tx` table `rewrite`/
`file_op` use, and this is permanent, not a gap: that table's
`EmittedFile.path` is a real path under `treeDir` (a revert writes bytes
straight to it), and a NAME proposal has no tree file at the point
`suggest_names` runs -- it operates on a fresh decompile, the same stage
landing 1's CLI pass does. Instead, `suggest_names` writes through the
name-overlay (`NameService`/`OverlayStore`), persisted to a sidecar under
`projectDir` (`overlayPathFor`, never beside the real `.hbc` input, which may
be a shared fixture). The overlay's own supersession chain already gives
reversibility (`OverlayStore.revert`) and provenance
(`NameRecord.source`/`gate`), so it needs no second bookkeeping system: a
name suggestion is equiv-verified (the section 9.4 NAME-row backstop, run
once per batch) and reviewable the same way the rename tool's own CLI review
loop always was. `list_suggestions` merges both sources into one
`SuggestionItem` union (`{kind:"name", suggestionId, ...}` from the overlay,
`{kind:"tx", tx}` from the transaction log); `promote_change`/`revert_change`
accept a `suggestionId` for the overlay case (`txId` still selects a
transaction) -- promoting re-records the same name via `NameService.setName`
(the "existing set_name promoter path") under the promoter's own `who` as
`source:"human"`, refusing any `who` starting with `worker:` before either
store is touched; reverting steps the overlay's active record back to
whatever was active before it. `classify_module` stays advisory only
(`txId`/`suggestionId` always `undefined`) -- landing 5's evaluator is its
review path. `rewrite_function` and `file_op` were never affected: both
materialise their accepted output into `treeDir` before recording, so a
later revert has real bytes to restore.

The suggestion pane's evidence/confidence/equiv-status columns, the
before/after diff, and the batch promote/revert filters (tier, confidence,
module, security-relevant) are documented in `docs/UI.md`.

## The evaluation loop -- opt-in, pluggable, never promotes (landing 5)

Correctness is always the equivalence oracle above, and that is never
pluggable. *Quality* review -- is this proposed name actually right, or does
it misrepresent the code -- is a different question, and who answers it
depends on how the tool was called (spec 28 section 1d.1):

- **A human on the UI** is always the reviewer. The `ui` surface never spawns
  an evaluator, even if a caller asks for one -- `evaluationModeFor` forces
  `human-ui` unconditionally for that surface.
- **An automated caller (MCP/CLI)** gets nothing extra by default (`none`:
  raw `suggested` + equiv-verified results) unless it wires an evaluator
  itself. That is the "opt-in" half: the harness never spawns a model on its
  own initiative.

### Wiring an evaluator

`src/readability/evaluate.ts` is the whole surface. An `EvaluatorPlugin` is
any object with `{id, mode, evaluate(items, signal?) -> Promise<EvaluationReport>}`.
Three are shipped:

- `NONE_PLUGIN` -- the default; an empty report.
- `createInlineCallerPlugin()` -- no backend call at all. Every item comes
  back with a `pending-caller` verdict: a placeholder for the calling agent
  (an orchestrator that is itself watching the result) to overwrite with its
  own judgement after grading inline. Use this when the caller IS the
  reviewer and does not want a second model spawned on its behalf.
- `createAgentEvaluatorPlugin({backend, id?})` -- a real second pass: any
  `WorkerBackend` at all (cheap self-eval for bulk names, a stronger model for
  hard targets), one `evaluate` job-kind call per item, `skills/hbc-evaluate.md`.

A caller wires a plugin on `ReadabilityContext` (`surfaces.ts`):

```ts
const ctx: ReadabilityContext = {
  db, projectDir, treeDir, backend, hbcPath,
  surface: "mcp",                    // never "ui" unless a human really is present
  evaluator: createAgentEvaluatorPlugin({ backend: evalBackend }),
};
const result = await suggestNames(ctx, { target: { fn }, evaluate: "agent" });
// result.evaluation is an EvaluationReport, or undefined when the mode
// resolved to "none"/"human-ui" or no evaluator was wired.
```

`suggest_names`, `classify_module` and `rewrite_function` all take an
`evaluate?: EvaluationMode` argument and return an `evaluation?:
EvaluationReport`. `runEvaluation(items, plugin, signal?)` -- the function
every plugin call actually goes through -- takes NO database and NO tier
argument, so an evaluation report cannot promote anything by construction: it
is judgements only (`{evaluator, mode, verdicts}`, no `promote`/`tier`/`txId`
field at all). Only a human or the ordinary `promote_change` path decides
what becomes `confirmed`.

### The adversarial re-check (spec 28 section 1b step 8)

A separate, narrower question from the "agent" evaluator above: **does this
name misrepresent what the function does?** It runs automatically inside
`runNamePass` when the caller wires `opts.adversarial = {backend}`, over
every name the pass just wrote that is either:

- flagged `securityRelevant` on its `NamePassTarget` (from a labelled sample,
  or from existing secrets/finding evidence in the project), or
- `high` confidence with `reach` above `ADVERSARIAL_REACH_THRESHOLD` (20
  call sites).

Each qualifying name gets one more backend call (`adversarial-recheck` job
kind, `skills/hbc-adversarial.md`). A `misleading` verdict demotes the
proposal to `low` confidence and prefixes its evidence with
`[flagged: misleading] <rationale> (was: <original evidence>)` -- `low`
confidence is never a promotion candidate (spec 28 section 4), so a demoted
name cannot slip through auto-promote, and the marker is visible wherever
that evidence is shown (the suggestion pane, `list_suggestions`). The
demotion is applied via `OverlayStore.demote`, an in-place patch of the
active record's confidence/evidence -- it does NOT create a new supersession
record, so it stays inside the same write `runNamePass`'s own equiv backstop
(section 9.4's NAME row) already tracks by timestamp; a correction made in a
later, separate review pass should go through `setName` instead, so it is its
own reviewable/revertible transaction.

On demand, outside a naming pass: `hbc2js readability review <input.hbc>
--adversarial [--security-relevant fn:reg,fn:reg,...] [--backend
haiku|replay|heuristic] [--recording <file>] [--store <path>]`. It reviews
the overlay's `source:"llm"` suggestion queue (no flags: just lists it) and,
with `--adversarial`, runs the same re-check over it, demoting any
`misleading` verdict in place and saving the store. `--security-relevant`
takes a comma-separated `fn:reg` list; every `high`-confidence suggestion
qualifies regardless (the reach leg has no CLI-level reach data yet).

### What it cannot do

An evaluator -- any of the three, or a caller's own -- never touches the
`suggested`/`confirmed` tier, never writes a transaction, and never reverts
anything. It ANNOTATES (`EvaluationReport.verdicts`) or, for the adversarial
re-check specifically, demotes a confidence level; promotion and reversal
stay exactly where spec 28 section 1d put them: a human, or the configured
promoter, working the review queue.
### The UI (landing 4c)

The same seven functions are also on HTTP, over `src/ui-server/
readability-routes.ts`: `GET /api/readability/suggestions` (the
`ListSuggestionsFilter` query params) wraps `list_suggestions`, `POST
/api/readability/{promote,revert}` wrap `promote_change`/`revert_change`,
and the four spec 28 section 9.7 UI actions are their own endpoints --
`POST /api/readability/actions/{suggest-names,rewrite-function,
combine-files,review}`. `review` calls straight into `listSuggestions` and
answers once it settles (nothing to enqueue, section 9.7). The other three
ENQUEUE (docs/PUSHBACK.md P-61, resolved landing 4d) through the SAME
`JobQueue`/`WorkerRunner` `/api/jobs` uses -- `JOB_KINDS` gained a
`readability-*` triple, `WorkerRunner.runReadabilityJob` dispatches them to
`suggestNames`/`rewriteFunction`/`fileOp`, and the route answers `202
{jobId}` for the caller to poll (P-60 is a different row, spec 28 landing
5's evaluator job kinds).

`ui/src/panes/WorkersPane.tsx`'s "AI" tab (docs/UI.md "AI workers") gains a
"Readability" section below the jobs rail: tier/confidence/module/
security-relevant filters (the last one now actually filters names,
landing 4d, docs/BUGS.md resolved), the evidence/confidence/equiv-status
columns, a before/after panel for `rewrite` transactions that renders
RENDERED TEXT (landing 4d, docs/BUGS.md resolved: `priorContent`/
`newContent` on the suggestions response, `prior` from the DB blob the
transaction log keeps for `revert`, `new` read live off `treeDir` --
falling back to path + hash when either is unavailable), reach ordering
(module order -- no xref caller-count reaches this pane yet), batch
promote/revert over the current filter, and the four actions in the
section header. `ui/src/workers/readability-wire.ts` hides the
enqueue-and-poll for the three write actions entirely -- `readability-
hooks.ts` and `WorkersPane.tsx` call `readabilityApi.suggestNames`/etc.
exactly as before landing 4d and get the surface's own result back, just
without blocking the HTTP request for however long the call takes.
`server.ts` builds a real `ReadabilityRoutesCtx` (`--llm-backend` CLI flag,
`treeDir` at `<projectDir>/src`, the shared project db), so
`/api/readability/*` answers for real against a real `ui-server` process.
Full details, including the one item still NOT wired (a real tree
multi-select feeding "Combine files" -- an interaction design call for
Fred, unresolved), are in docs/UI.md's "Readability section" and spec 28
section 10 Landing 4's own status paragraph.
