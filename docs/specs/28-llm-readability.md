# Spec 28 — LLM readability layer (Haiku-backed naming + doc)

> Status: **IDEAS/DRAFT** (Fred 2026-09-11: "a tool that calls Haiku with a
> couple of skills and turns the app into readable code"). Fills the biggest of
> the three product gaps (STATUS scoreboard: var-naming names only ~10-20% of
> registers, ~1-15% of `src/` modules; mechanical passes plateau there). An LLM
> is exactly the right tool for *semantic* naming from context; Haiku is cheap
> enough to run across a whole app's `src/` tree.

## 0. The one-paragraph shape

A new **`HaikuBackend`** implementing the existing `WorkerBackend` interface
(`src/workers/backend.ts`: `{ id, run(req, signal) → { text, cost } }`) —
the model-backed sibling of `HeuristicBackend` and `FakeBackend`. It runs the
**already-defined** spec-23 job kinds (`suggest-name`, `name-module`,
`explain-fn`, `doc-screen`) by calling Haiku with a **skill** loaded per kind.
Its output flows through the **already-built** write path: the runner turns each
result into overlay writes (`set_name`, `add_comment`) into the **Design-D
naming overlay** (non-destructive, keyed to `{fn, reg}` binding IDs, applied at
emit/render time). So this spec adds a *brain and skills*, not new plumbing.

```
job (suggest-name fn:8871)                        <- spec 23 queue/runner (exists)
   → HaikuBackend.run({kind, prompt, context})    <- NEW (this spec)
       context = source + xrefs + strings         <- artifact/MCP get_context (exists)
       prompt  = skill(kind) + context            <- NEW skills (this spec)
       → Haiku → {names:[{bindingId, name, confidence, evidence}], doc?}
   → runner writes overlay suggestions             <- Design-D overlay + MCP set_name (exists)
   → render applies names through the reuse gate   <- src/emit (exists)
```

## 0a. The safety harness — CANNOT make the code invalid or different (Fred 2026-09-11)

Fred's framing (2026-09-11): **the LLM may provide rewrites, not just renames —
as long as the result is functionally the same.** So the harness is NOT "don't
touch the code"; it is **"every transformation must pass the equivalence
oracle."** That unlocks real readability work — restructure a lowered
state-machine back to a `for` loop, collapse redundant temps, recover
JSX/destructuring, un-inline, simplify expressions — with naming as the
conservative subset.

THE SINGLE GUARANTEE: **`hbc2js equiv --hbc <bundle.hbc> <rewrite.js>`** (the
project's existing trace-equivalence oracle: Hermes-VM behaviour of the bytecode
vs. the rewritten JS) must pass for a rewrite to be accepted. **Accept iff
equivalent; otherwise discard the rewrite and keep the faithful original.**
"Functionally the same" is *defined* as passing this oracle, so a rewrite that
doesn't parse, doesn't run, or changes behaviour is rejected by construction —
it can be neither invalid nor synthetically different.

Two truth-first properties:
- **The faithful decompile is always retained** as ground truth; the readable
  rewrite is a *second, equivalence-proven rendition* stored alongside it (the
  naming overlay is the reversible-label case). A failed rewrite falls back to
  the faithful version — you never lose it.
- **The oracle is trace-equivalence — as strong as its trace coverage.** It is
  the project's standard fidelity bar, not a total formal proof: an aggressive
  rewrite could differ on an untested path. Mitigation already in the repo: run
  the equiv check with **rich/fuzzed inputs** (the construct fuzzer, spec 09) so
  "equivalent" spans a wide input space, and prefer conservative rewrites where
  trace coverage is thin. Report the coverage a rewrite was proven over.

The per-name checks below are a cheap **pre-filter** for the naming subset (drop
obviously-broken candidates before the more expensive equiv run) — but the equiv
oracle, not these checks, is the actual guarantee:

1. **Bounded rename domain.** The overlay may rename ONLY: local bindings
   (`{fn, reg}` registers), a declared function's own name (all references
   updated consistently), and module filenames (+ their import paths). It may
   **NEVER** rename an object property key (`foo.bar`), a global reference, or a
   dynamically/string-referenced identifier — those change behavior. Names
   outside the domain are rejected at write time.
2. **Legality + collision/shadow gate at render.** Every name is validated:
   legal JS identifier, not a reserved word, and no in-scope **collision or
   shadowing** (never resolves a reference differently). Fail ⇒ the name is
   dropped or uniquified; the original binding renders unchanged. Render never
   emits invalid JS by construction.
3. **Equivalence-oracle gate (the clincher).** The named output is run through
   the project's existing fidelity oracle — `hbc2js equiv --hbc <bundle.hbc>
   <named.js>` (trace-equivalence between the Hermes bytecode and the rendered
   JS). A correct alpha-rename is semantics-preserving, so this ALWAYS passes;
   any name that would change behavior is **caught and rejected** by the same
   oracle the whole project trusts. This turns "should be safe" into "provably
   identical behavior to the original bytecode."

Net guarantee: with (1)-(3), the LLM can only ever produce a **relabelled but
provably-equivalent** view of the faithful decompile. It cannot make the code
invalid (rule 2) and cannot make it synthetically different (rules 1+3). This is
a build requirement, gated in tests (§7), not a hope.

## 1. Truth first (non-negotiable — this is the project's #1 rule)

The LLM **never rewrites code or changes semantics**. It only proposes
**labels** (register/function/module names, one-line docs) that live in the
overlay. The decompiled JS stays byte-for-byte faithful; a name is a **clearly
marked, reversible hypothesis about** faithful code, never presented as truth.
Enforced by:
- **Overlay-only writes** (Design D §8): names key to `{fn, reg}`; the factory
  body is never edited. Render applies them through var-naming's reuse gate, so
  an unsafe name is dropped, not forced.
- **Provenance + confidence**: every LLM name is stamped `who: worker:haiku`,
  `tier: suggested`, and carries an **evidence** field citing *why* (the string
  literal / endpoint / call site that motivated it). No evidence ⇒ low
  confidence, never auto-promoted.
- **Reversible / searchable / history**: Design D already gives revert, search,
  and per-name history. A wrong LLM name is one `name revert` away and never
  destroys the original.
- **Promotion gate**: `suggested → confirmed` requires a human or a stronger
  model (Opus) to promote (reuses the spec-23 promote path). Haiku fills the
  overlay with hypotheses; it does not get to declare them true.

## 1b. Modus operandi — the per-target loop

The tool follows the project's own **generate → validate → verify → promote**
discipline. For each in-scope target (a `src/` function or module), in
evidence-directed order (highest reach + strongest signal first):

1. **GATHER** — pull the context the artifact already paid for: decompiled
   source, callers/callees, string-uses (endpoint constants, literals), and the
   module's segregation role. No new decompile.
2. **CACHE CHECK** — content-hash `(kind, body, context)`. Hit ⇒ reuse the prior
   name, skip the model call. (Re-runs and version bumps re-name only what
   changed.)
3. **LOAD SKILL** — the skill for the kind (`hbc-name` / `hbc-classify` /
   `hbc-doc`) goes into the prompt.
4. **GENERATE** — call Haiku with skill + context → either a **rename set**
   (`{bindingId, name, confidence, evidence}[]`, the conservative default) or a
   **readable rewrite** of the whole function body (when restructuring buys real
   clarity), plus optional doc. **Abstain** (emit nothing) when there is no
   evidence or the original is already clear; never invent.
5. **VALIDATE (safety harness §0a, rules 1-2)** — for each proposed name:
   in the bounded rename domain? legal identifier, not reserved, no in-scope
   collision/shadow? Fail ⇒ drop/uniquify. Only survivors proceed.
6. **WRITE (non-destructive)** — surviving names land in the Design-D overlay as
   **suggestions**, stamped `who: worker:haiku`, `tier: suggested`, with the
   `evidence` and `confidence`. The factory body is never touched.
7. **VERIFY (§0a, the guarantee)** — render the candidate and run
   `hbc2js equiv --hbc <bundle.hbc> <rewrite.js>` on the affected function(s),
   with fuzzed inputs where coverage is thin. **Accept iff equivalent**; a
   rewrite (or name) that fails is discarded and the faithful original stands.
   Pure alpha-renames pass trivially and may skip the full run; every
   restructuring rewrite must clear the oracle.
8. **ADVERSARIAL RE-CHECK (high-value only)** — for security-relevant or
   high-reach names, a second pass asks "does this name misrepresent the code?"
   before the name becomes promotable.
9. **PROMOTE** — names stay `suggested`. A human or Opus promotes
   `suggested → confirmed` (reuses the spec-23 promote path). **Haiku never
   self-promotes** — it fills the overlay with hypotheses; it does not declare
   them true.
10. **BUDGET** — stop cleanly at `--budget-usd`; evidence-directed order means
    the cap still buys the most valuable names. Record cost per run.

Invariant across every step: the underlying decompile is untouched and, after
step 7, **provably equivalent** to the bytecode — the loop only ever adds a
reversible, evidence-backed label.

## 1c. File-tree operations — every one traced by the DB (Fred 2026-09-11)

Readability isn't only within a function. The tool may reshape the **file tree**:

- **make** — create a new file (extract a component/hook/util into its own
  file; give a `module_N.js` a real path like `src/auth/LoginScreen.js`).
- **rename/move** — give a module a meaningful filename + directory.
- **combine** — merge modules that are really one unit into one file.
- **split** — break a mega-module into several readable files.

**All of it is traced by the DB** (`project.hbcproj`), per spec 18's model:
the DB is the **operational source of truth**, and every file operation is a
recorded, provenance-stamped, **reversible transaction** in a *readability
transformation log*. Each entry carries:

- `op` (make/rename/combine/split/move), `who: worker:haiku`, `tier: suggested`,
  timestamp;
- **inputs → output**: the original **module indices / `{fn,reg}` binding IDs**
  that went in, and the file(s) that came out — so **every readable file traces
  back to its exact bytecode origin**. No matter how much the tree is reshaped,
  nothing is orphaned from the binary (the truth-first anchor);
- the **equivalence proof** it passed (see below) + coverage;
- enough to **revert** it (spec 18 already gives DB→JSON hash-lock, git-tracked,
  and DB regeneration from JSON for recoverability).

**Equivalence extends to the file tree.** A combine/split/rename changes module
structure, so the guarantee widens: after the file ops, the **reconstructed tree
must still pass `hbc2js equiv --hbc <bundle.hbc>`** as a whole — the require
graph resolves the same, exports are preserved, behaviour is identical. A file
op that breaks module-resolution or behaviour fails equiv and is discarded, same
accept-iff-equivalent rule as §0a, just at tree granularity.

Net: the DB is the single **audit + undo log** for the entire readability layer
— names, rewrites, and file operations alike — each reversible, each traceable
to the bytecode, each equivalence-proven. Nothing the LLM does escapes the DB or
the oracle.

## 1d. The reviewer — accept, revert, or edit (Fred 2026-09-11)

Two layers of judgement, and they catch different things:

- **The equivalence oracle judges CORRECTNESS** (automated): is it the same
  program? A change that fails is never even offered.
- **The reviewer judges QUALITY** (human, or an Opus review pass): is this a
  *good, accurate* rendition? The oracle can't catch a **misleading-but-
  equivalent** name (`getUser` for a session fetch), an equivalent-but-uglier
  rewrite, or a nonsensical file grouping. That's the reviewer's job.

So every LLM change lands as **`suggested`** (a reversible DB transaction, never
silently canonical), and a reviewer works the queue:

- **REVERT** — don't like it ⇒ one-click undo. Because every action is a DB
  transaction (§1c) with the prior state recorded, revert is exact and clean —
  names, rewrites, and file ops alike. **The reviewer can always throw a change
  away.**
- **PROMOTE** — good ⇒ `suggested → confirmed` (the spec-23 promote path). Only
  confirmed changes are treated as the canonical readable view.
- **EDIT** — nearly right ⇒ tweak the name/rewrite and promote the edited
  version (recorded as the reviewer's own transaction, provenance `who: <user>`).

Ergonomics (reuse the spec-22..26 UI): review in the pane that already shows
suggestions, with the **evidence, confidence, and equiv-status** on each, and a
**before/after diff**; batch-filter (e.g. promote all `high`-confidence, revert
all `low`), and sort by reach so the reviewer spends attention where it matters.
Haiku **never self-promotes** — it only fills the `suggested` queue; a human or
Opus decides what becomes canonical, and can bin anything.

### 1d.1 Who evaluates quality — context-dependent, and NOT necessarily Opus (Fred 2026-09-11)

Correctness is always the equiv oracle (automated, always on). *Quality* review
depends on how the tool was called — don't spawn an evaluator when a human is
already watching, and don't skip evaluation when no one is:

- **Interactive (UI / browser)** — a human is present, so **the human is the
  reviewer**. No evaluator agent is launched; the `suggested` queue (§1d) is the
  review surface. Cheapest, and the default when a person is driving.
- **Automated (MCP / CLI / a harness or agentic rewriter driving it)** — no
  human is watching, so an **evaluation loop** runs to judge quality. It is
  **pluggable and configurable**, not hard-wired to Opus:
  - a **separate evaluator agent** spawned after the rewrite (model chosen per
    stakes — cheap self-eval, e.g. Haiku grading Haiku, for bulk names; a
    stronger model only for hard/security-relevant targets), **or**
  - **the calling/"main" agent evaluates inline** (an orchestrator that called
    the tool grades the result itself — no extra spawn), **or**
  - **none** — return the `suggested`+equiv-verified results raw for the caller
    to decide.
  Which one is a project/config choice; the harness picks per how it's wired.

**The evaluation loop is a built-in, opt-in harness component** — an automated
caller can *layer it on* (request an eval pass with a chosen evaluator) without
changing the core. So the tool is cheap/free by default (oracle + DB only) and
gains a quality-evaluation loop when a caller asks for one. Regardless of
evaluator, only `confirmed` changes are canonical and anything can still be
reverted (§1c/§1d).

## 1e. Callable from the UI AND from other agentic rewriters (Fred 2026-09-11)

The readability engine (HaikuBackend + queue + equiv gate + DB) has ONE core and
**three call surfaces** that all drive it — a caller never bypasses the oracle or
the DB trace:

1. **From the UI** (spec 22-26). Actions like "suggest names for this module",
   "make this function readable", "combine these files" enqueue the spec-23
   jobs; results land in the review queue (§1d) for accept/revert/edit. The
   human triggers it and reviews it in one place.
2. **From other agentic rewriters — via MCP** (the key new requirement). The
   operations are exposed as **typed MCP tools** so any external agent (another
   Claude, a different rewriter, an orchestrator) can call them
   programmatically:
   - `suggest_names(target)`, `rewrite_function(fn)`, `classify_module(mod)`,
     `file_op({make|rename|combine|split}, inputs)`, `promote(id)`,
     `revert(id)`, `list_suggestions(filter)`.
   - Every call returns **equiv-verified, DB-tracked, reviewable** results — an
     external agent gets the same safety (oracle + DB + `suggested` tier) as the
     UI; it cannot push an unverified change or an untraced one. So hbc2js's
     readability becomes a **service other agents consume**, and its guarantees
     travel with the call.
3. **From the CLI** (batch): `hbc2js name llm-fill …` (§3) for bulk passes.

**Pluggable backend, too.** Because the core is the `WorkerBackend` interface,
Haiku is just the default rewriter — a "major other agentic rewriter" (Opus, a
specialised model, an external agent) can be the *backend* as well as a *caller*,
selected per job (cheap Haiku for bulk, a stronger one for hard/security-relevant
targets). The oracle and DB trace are identical regardless of which rewriter
produced the candidate.

## 2. The skills (Fred's "couple of skills")

Skills are packaged instructions loaded into the prompt per job kind. Ship 2
to start, a 3rd optional:

1. **`hbc-name`** (for `suggest-name`) — how to name registers/functions from
   decompiled source + xrefs. Rules: prefer evidence (string literals, endpoint
   paths, called API names, the module's role) over guessing; JS-idiomatic
   camelCase; name the *thing's role*, not its type; **do not rename** a slot
   that already has a good name; emit `{bindingId, name, confidence, evidence}`
   per proposed name; abstain (empty) when there's no signal rather than invent.
   This is the "best-practice naming" discipline expressed as a skill.
2. **`hbc-classify`** (for `name-module`) — given a module's source + the
   segregation signals (bucket, nameSignal, deps), classify its role
   (`screen` / `navigator` / `store` / `api-client` / `component` / `util`) and
   propose a file name (`LoginScreen.js`, `useAuth.js`, `apiClient.js`). Only
   `src/` modules; `node_modules` are already identified by deps and are skipped.
3. *(optional)* **`hbc-doc`** (for `doc-screen`/`explain-fn`) — a one-line
   doc comment per function/module: what it does, its inputs/outputs, and any
   trust-boundary note. Never speculative beyond the evidence.

Skills live in the repo (versioned) so the naming discipline is auditable and
improvable — a bad name pattern is a skill edit, not a prompt hack.

## 3. Scope & scale (Haiku is cheap, but not free)

- **`src/` only.** After segregation, the app code is a few hundred modules;
  the ~4000 `node_modules` on NSW are already named by `deps` — skip them.
  (NSW: 4510 modules → 176 screens + a small `src/` set is the real target.)
- **Evidence-directed ordering.** Name the high-signal, high-reach functions
  first (many callers, endpoint/string evidence) so value lands early and a
  budget cut-off still helps.
- **Content-hash caching.** Key each result on a hash of `(kind, function body,
  context)`. A re-run or a version bump re-names only what changed — the same
  operational-cache discipline as spec-18/segregation.
- **Batch mode + the live worker path both work.** Batch: `hbc2js name
  llm-fill <project> [--kinds suggest-name,name-module] [--only src]
  [--budget-usd N] [--backend haiku]` enqueues jobs for every in-scope target
  and drains the queue. Live: the UI's spec-23 workers already enqueue these
  kinds; swapping the backend to `haiku` makes them real.

## 4. Verification (a name is a hypothesis until checked)

- **Confidence tiers** from the model + evidence: `high` (a literal names it),
  `med` (strong contextual inference), `low` (guess). Only `high` is a
  candidate for auto-promote; `low` stays suggested.
- **Optional adversarial re-check** for promotion of high-value names: a second
  pass (Opus, or Haiku with an adversarial prompt) asks "does this name
  misrepresent the code?" — cheap insurance against a confident-wrong label on
  a security-relevant function. Reuses the generate→verify pattern.
- **Consistency check**: the same underlying library function named twice must
  agree; disagreement flags a low-confidence bucket.

## 5. What's NEW vs REUSED (small surface)

REUSED (no change): spec-23 queue/runner/presence, the `WorkerBackend`
interface, the 4 job kinds, `get_context`/artifact reads, the Design-D overlay
+ `name set/get/revert/search/list`, MCP `set_name`/`add_comment`, `src/emit`
render, spec-18 caching.
NEW (this spec): `src/workers/backends/haiku.ts` (the backend, ~one `run`
method calling the Anthropic API with the skill), the 2-3 skill files, the
`name llm-fill` batch CLI, the content-hash name cache, and the optional
verify pass.

## 6. Cost note

Haiku per `src/` function is small; NSW's real `src/` target is hundreds of
modules, not thousands. A whole-`src/` naming pass should be well under the cost
of the Opus/Fable spec work. The batch CLI takes `--budget-usd` and stops
cleanly at the cap (evidence-directed order means the cap still buys the most
valuable names). Cost per run recorded in `WorkerJobResponse.cost` and the
AGENT-LOG, per the tokens-not-dollars convention.

## 7. Acceptance / measurable targets (spec-gate requirement)

Ship the acceptance tests with the spec (spec-agent writes them first). Targets,
measured on the NSW `src/` tree + a held-out app:
- **Coverage**: ≥70% of `src/` registers and ≥80% of `src/` modules get a
  non-`module_N`/non-`rN` name (vs today's ~10-20% / ~1-15%).
- **Quality**: on a hand-labelled sample, ≥80% of `high`-confidence names judged
  accurate (a human or Opus rater); **zero** name that misrepresents a
  security-relevant function survives the verify pass.
- **Fidelity**: the decompiled JS is byte-identical with and without the overlay
  applied-then-reverted (proves overlay-only, no semantic drift).
- **Cost**: whole-NSW-`src/` pass under a stated USD/token budget; cache makes a
  re-run ≥90% cheaper.
- **Reversibility & DB trace**: every LLM action — name, rewrite, AND file op
  (make/rename/combine/split) — is a reversible DB transaction carrying evidence
  + provenance; reverting any one restores the prior tree exactly (100%,
  checked). No action mutates the tree without a DB record.
- **Traceability**: every readable file (however combined/split/renamed) records
  the original module indices / `{fn,reg}` binding IDs it derives from; 100% of
  emitted files trace back to bytecode origin, zero orphans.
- **Tree-level fidelity**: the reconstructed file tree (after all name/rewrite/
  file ops) passes `hbc2js equiv --hbc` as a whole — require graph and behaviour
  identical to the bytecode.

## 8. Open questions for Fred

- Auto-promote `high`-confidence names, or leave everything `suggested` for
  human/Opus promotion? (Default: leave suggested; truth-first.)
- Run as a batch CLI pass (fill the whole `src/` tree once) or purely
  on-demand via the UI workers, or both? (Default: both; batch for bulk, live
  for interactive.)
- Ship `hbc-doc` (3rd skill) now or after naming lands? (Default: after.)
