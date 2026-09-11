# Spec 28 — LLM readability layer (Haiku-backed naming + doc)

> Status: **ACCEPTED (spec-agent 2026-09-11)**. Every open contract is settled
> in sections 9-11 below; the acceptance tests ship with this spec in
> `tests/gate/llm-readability/` (green where they can run today, RED-SKIPPED
> with a landing number where they cannot). Originally drafted as (Fred 2026-09-11: "a tool that calls Haiku with a
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
verify pass. Landing 5 adds two more job kinds to spec 23's list --
`evaluate` (the "agent" evaluator plugin, section 9.6, skill `hbc-evaluate`)
and `adversarial-recheck` (section 1b step 8, skill `hbc-adversarial`) --
because both `HaikuBackend` and `ReplayBackend` route the skill to prompt
with solely from the job kind (`SKILL_FOR_KIND`), never from the caller's
`prompt` string, so a second question needs a second kind (docs/PUSHBACK.md
P-60). `src/readability/evaluate.ts` (the plug-in host + the adversarial
re-check) and `skills/hbc-evaluate.md`/`skills/hbc-adversarial.md` are new;
everything else in this list is unchanged.

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

## 8. Section-8 defaults, taken as decisions (was "open questions for Fred")

The draft's three open questions are settled at their stated defaults. Each is
a decision now, not a preference:

- **D28-1 Promotion.** Everything the model produces lands `suggested`.
  Nothing auto-promotes, not even `high` confidence. `suggested -> confirmed`
  needs a human or a stronger model acting as the promoter, with the promoter's
  own provenance (the spec-23 / spec-17 promote path). Enforced in code:
  `validateTransaction` rejects any transaction whose `who` starts with
  `worker:` and whose `tier` is `confirmed`.
- **D28-2 Batch and live.** Both. The batch CLI (`name llm-fill`, section 3)
  fills a whole `src/` tree; the spec-23 workers serve the UI on demand. They
  are the same core with two callers, and the cache is shared, so a live run
  after a batch run is nearly free.
- **D28-3 `hbc-doc` deferred.** Landings 1-4 ship `hbc-name` and `hbc-classify`
  only. `hbc-doc` is a legal `SkillId` with no file on disk; `loadSkill`
  throws for it, and `tests/gate/llm-readability/skills.test.ts` pins that
  absence so "deferred" cannot drift into "forgotten". It lands with landing 5
  at the earliest, and only if naming has cleared its section 7 targets.

## 9. Settled contracts

### 9.1 `HaikuBackend implements WorkerBackend` (opt-in API backend)

Lives in `src/workers/backends/haiku.ts` (landing 1). It is the third
implementation of the interface already in `src/workers/backend.ts`
(`{ id, run(req, signal) }`), alongside `FakeBackend` and `HeuristicBackend`;
the runner is unchanged. **Landing 1b makes it opt-in**: the DEFAULT backend
is `ClaudeCliBackend` (9.1a below, Fred's 2026-09-11 ruling), because the API
is metered and the CLI runs on a plan Fred already pays for.

**Constructor config** is `HaikuBackendConfig` (`src/readability/types.ts`),
resolved by `resolveHaikuConfig(env, overrides, projectDir)` in that precedence:
explicit overrides, then environment, then defaults.

| field | default | env override | meaning |
| --- | --- | --- | --- |
| `model` | `claude-haiku-4-5-20251001` | `HBC2JS_LLM_MODEL` | model id; any Anthropic model id is legal, so a caller can point the same backend at a stronger model per job (section 1e) |
| `budgetTokens` | 2000000 | `HBC2JS_LLM_BUDGET_TOKENS` | hard stop for one run, in TOKENS (the project's tokens-not-dollars convention). Reaching it stops the run cleanly between targets, never mid-write |
| `cacheDir` | `<projectDir>/cache/llm-readability` | `HBC2JS_LLM_CACHE_DIR` | content-hash cache root. Derived data: gitignored, rebuildable, spec 18 section 4 |
| `skillsDir` | `skills` | - | where skill files are loaded from |
| `maxOutputTokens` | 2048 | - | per-call output cap; must not exceed `budgetTokens` |
| `apiKeyEnv` | `ANTHROPIC_API_KEY` | - | the NAME of the variable the credential comes from. The config never holds the value, so a config object is always safe to log or store in a job record |

Unusable values are refused (`ReadabilityConfigError`), never clamped: an empty
model id, a zero/negative/fractional budget, a non-numeric budget, or a
per-call cap larger than the whole-run budget.

**What it sends, per job kind.** One user message, built as
`skill.body + "\n\n" + context`, where `skill` is `loadSkill(SKILL_FOR_KIND[kind])`
and `context` is the `get_context` payload the runner already assembled (spec 23
section 7: a job never fetches its own data). Nothing else: no repo files, no
bundle bytes, no prior conversation.

| kind | skill | context the runner supplies |
| --- | --- | --- |
| `suggest-name` | `hbc-name` | rendered function source, summary (`fn`, module, params, lines, existing overlay name, edge counts), xrefs, string literals, module role |
| `name-module` | `hbc-classify` | module source, export shape, placeholder path, dependency edges, segregation bucket and name signal, string literals |
| `explain-fn`, `doc-screen` | `hbc-doc` (deferred, D28-3) | as `suggest-name`, plus the screen's route evidence |

**What it returns.** `WorkerJobResponse.text` is one JSON object matching the
skill's output contract, parsed by `parseReadabilityResult` into
`ReadabilityResult`: `names: {bindingId, name, confidence, evidence}[]`, an
optional function-level `rewrite`, an optional `doc`, and `abstained`.
`WorkerJobResponse.cost` carries `tokensIn`/`tokensOut`. The parser NEVER
throws: malformed model output is a rejected candidate, not a crashed run, and
a proposal with empty `evidence` is forced down to `low` confidence so it can
never be auto-promoted.

**Cache keys.** `cacheKey({kind, skillId, skillVersion, model, body, context})`,
a SHA-256 over length-prefixed fields, so content cannot migrate between fields
to forge a hit. A hit skips the model call entirely; a skill edit (version bump)
or a changed body/context invalidates exactly the affected entries. That is what
makes a re-run over an unchanged tree >= 90% cheaper (section 7), and what makes
a version bump re-name only what changed.

**No test ever calls the network.** The gate drives a recorded or fake backend
behind the same interface (`FakeBackend`, or a replay backend reading committed
JSON), never `HaikuBackend`. `src/readability/**` imports no transport module at
all and no model SDK is added to `package.json`; both are asserted mechanically
in `tests/gate/llm-readability/interface-shape.test.ts`. The one place a socket
may ever be opened is `src/workers/backends/haiku.ts` (landing 1b adds a
second, narrower exception: `src/workers/backends/claude-cli.ts` spawns a
subprocess, never a socket directly), and the gate does not import either.

### 9.1a `ClaudeCliBackend` (default) -- landing 1b, Fred's 2026-09-11 ruling

Fred (verbatim, 2026-09-11): "It should run on the Claude plan on the shell.
I think you can pass in a prompt to the agent through a flag on the command
line. they should not be using the API because API is more expensive." and
"You should have an API option if it's easy to integrate, but you should not
be going through API as default."

`src/workers/backends/claude-cli.ts` is therefore the DEFAULT `WorkerBackend`
for every job kind `SKILL_FOR_KIND` routes; `HaikuBackend` (9.1 above) is now
the **opt-in** API backend, selected with `--backend haiku` or
`HBC2JS_LLM_BACKEND=haiku`, and still requires `ANTHROPIC_API_KEY`.

**Config**: `ClaudeCliBackendConfig` (`src/readability/types.ts`), resolved by
`resolveClaudeCliConfig(env, overrides, projectDir)` with the same precedence
and the same shared fields as `HaikuBackendConfig` (`model` -- default the
alias `"haiku"`, not a full model id, since `claude --model` accepts aliases;
`budgetTokens`, `cacheDir`, `skillsDir`, `maxOutputTokens` -- kept for
config-surface parity, not passed as an argument because the `claude` CLI has
no per-call output-token flag), plus `claudeBin` (default `"claude"`, env
`HBC2JS_CLAUDE_BIN`) and `timeoutMs` (default 120000, env
`HBC2JS_CLAUDE_TIMEOUT_MS`).

**What it sends**: `child_process.spawn(claudeBin, [...], {stdio: [...]})` --
no shell, so prompt content is never re-interpreted --
`-p <canonicalised context>`, `--model <model>`, `--output-format json`,
`--tools ""`, `--no-session-persistence`, `--system-prompt <skill.body>`. This
differs from `HaikuBackend`'s single concatenated user message: the CLI has a
dedicated system-prompt channel, so the skill discipline (system prompt) and
the per-job data (`-p` prompt) are two fields, not one.

**What it returns**: the CLI's `--output-format json` prints one JSON object
with `result` (mapped to `WorkerJobResponse.text`), `is_error`, `stop_reason`,
`usage.{input_tokens,output_tokens,cache_creation_input_tokens,
cache_read_input_tokens}` (all four count toward `cost.tokensIn`;
`output_tokens` is `cost.tokensOut`) and `total_cost_usd` (recorded as
`cost.usd`, informational only -- the project's budget accounting stays
tokens, per 9.1's table, never dollars). `is_error: true`, a non-zero exit, a
timeout, or unparseable stdout all throw `TransientBackendError` (retryable);
a missing binary throws `ReadabilityConfigError` (permanent -- fix the
install, do not retry). `stop_reason: "max_tokens"` is a rejected candidate,
not a throw: whatever text came back is handed on exactly like any other
result, and `parseReadabilityResult` downstream treats anything that fails to
parse as an abstention.

**Cache keys**: the SAME `cacheKey` function and fields as `HaikuBackend`
(9.1's cache-key discipline), so a recording made against either backend
replays for the other as long as the `model` field in the request matches.

**Selection**: one place maps a backend id to a constructor --
`src/readability/backends.ts`'s `backendForId`/`resolveBackendId`. Precedence:
`--backend` (CLI) > `HBC2JS_LLM_BACKEND` (env) > `claude-cli` (default). IDs:
`claude-cli`, `haiku`, `replay`, `heuristic`, `fake`. `hbc2js name llm-fill`,
`tools/readability/record.ts` and the UI worker pool (`src/ui-server/
server.ts`'s `buildUiBackend`, routing only `SKILL_FOR_KIND`'s job kinds to
the LLM backend and everything else to `HeuristicBackend`) all resolve through
it, so the default cannot drift between callers.

### 9.2 Skill files

- **Location**: `skills/<id>.md`, repo root, git-tracked, versioned. Shipped:
  `skills/hbc-name.md`, `skills/hbc-classify.md`. Deferred: `skills/hbc-doc.md`
  (D28-3).
- **Format**: a `---` front-matter block with `id`, `kind` (comma-separated job
  kinds) and `version` (positive integer), then a markdown body that MUST
  contain the H2 sections `Inputs`, `Rules`, `Output contract`, `Abstain`. The
  body, front matter stripped, is what goes into the prompt.
- **Loading**: `loadSkill(id, dir)` in `src/readability/skills.ts`. It refuses a
  skill whose front matter is missing or malformed, whose version is not a
  positive integer, whose declared `kind` is routed to a different skill by
  `SKILL_FOR_KIND`, or which is missing any required section. A backend loads
  one skill per job kind, once, and caches it for the run.
- **Why files**: a naming-discipline change is then a reviewable diff with a
  version bump that invalidates exactly the cache entries it should, not a
  prompt edited in code.

### 9.3 The cache

`cacheDir` holds one JSON file per key: the request digest, the raw response
text, the parsed result, and the cost. It is DERIVED data under spec 18 section
4: gitignored, rebuildable, never authoritative. The authoritative record of
what was written is the overlay + the transaction log (9.5).

### 9.4 The equiv-gate contract

"Passes" is defined per change class. Failure is always the same: the candidate
is discarded, the faithful original is retained, and the attempt is logged (with
the oracle verdict and the coverage it was proven over) so a human can see what
was tried and rejected.

| class | what is checked | "passes" means |
| --- | --- | --- |
| **NAME** (register, function name, module filename) | the change is overlay-only: apply the name set, render, revert the name set, render again | the two renders are **byte-identical**, and the bounded-domain + legality/collision gates (section 0a rules 1-2) dropped nothing silently. A correct alpha-rename is semantics-preserving, so the expensive oracle run is not required per name; it is run once per batch as a backstop |
| **REWRITE** (function-level, landing 2) | `hbc2js equiv --hbc <bundle.hbc> <rewrite.js>` restricted to the affected function, with fuzzed inputs where trace coverage is thin | verdict **PASS**. `DIVERGENT` and `INCONCLUSIVE` both reject; INCONCLUSIVE is never PASS (the harness rule) |
| **FILE OP** (make / rename / move / combine / split, landing 3) | tree-level `hbc2js equiv --hbc <bundle.hbc> <tree/>` over the reconstructed tree: require graph resolves the same, exports preserved, behaviour identical | verdict **PASS** for the whole tree, not just the touched files |

The REWRITE row's oracle is callable, not a CLI invocation: `src/harness/hbc-equiv.ts`
exports `hbcVsJsUnderHermes` (the `equiv --hbc` comparison itself, which
`src/cli.ts` now also calls) and `runFunctionEquiv` (the two-leg gate:
`module-hbc` plus, when the module's trace coverage is thin, a
`function-fuzz` differential of the faithful function against the rewritten one
over spec 09's seeded corpus). Library code never shells out to the CLI.

Every accepted change stores an `EquivProof` (`scope`, `verdict`, the verbatim
`oracle` invocation, `coverage: {inputs, records}`, `ts`), so a proof is
reproducible by hand and its strength is visible. `equivAccepts(proof)` is the
single predicate; `validateTransaction` refuses any transaction whose proof did
not pass.

### 9.5 The readability transaction log (extends spec 18)

Every file op is a row in a new table in `cache.db`, exported to a new
hash-locked shard family `analysis/readability/<id>.json` and appended to the
existing hash-chained `log/<date>.jsonl` with `provenance` per spec 18 section
6. Nothing new is invented about integrity: the shard hash, the state binding
and the log chain are spec 18's, unchanged.

Shape (`ReadabilityTransaction` in `src/readability/types.ts`):

| field | meaning |
| --- | --- |
| `id` | content hash of the immutable defining fields (op, inputs, outputs, evidence) -- spec 18 section 7's allocation rule, so the same op dedups for free |
| `op` | `make` / `rename` / `move` / `combine` / `split` / `rewrite` (`TRANSACTION_OPS`). `rewrite` is landing 2's function-level change, made first class here (docs/PUSHBACK.md P-58, resolved): its inputs are the `{fn}` binding it rewrote and its outputs the one file it touched, so it obeys the same dedup, the same zero-orphan rule and the same revert path as a file op. `FILE_OP_KINDS` stays the five FILE ops -- `file-ops.ts` and the `file_op` MCP tool are about the tree |
| `who`, `tier`, `ts` | provenance stamp. `who: worker:haiku`, `tier: suggested` for anything the model did; a promoter writes its own `who` |
| `inputs` | the `BindingOrigin[]` that went in: module indices and, where the op is finer than a module, `{fn,reg}` binding ids |
| `outputs` | `EmittedFile[]`: each emitted path plus the `origins` it derives from. **An output with zero origins is an orphan and invalidates the transaction** -- this is what makes section 7's traceability target checkable rather than aspirational |
| `equiv` | the `EquivProof` (9.4) the change passed |
| `evidence` | why the op was proposed, citing the literal / route / endpoint |
| `prior` | `{path, sha256}` for every file the op replaced. Empty is legal only for `make`. This is the reversibility guarantee: revert rewrites exactly these paths back to exactly these hashes |

**Reversibility guarantee.** Reverting transaction T restores the tree to its
state immediately before T, byte for byte, because `prior` records the full
content hash of every path T touched and the DB holds the content. Reverts are
themselves transactions (so a revert is auditable and a revert-of-a-revert
works), and because a file op is committed in one DB transaction before export
(spec 18 section 6), a crash mid-op leaves either all of it or none of it.

**What a shard carries.** `analysis/readability/<id>.json` is the transaction
verbatim plus a `blobs` map holding the exact bytes of every `prior` hash, so
the JSON side is a complete recovery source: `hbcproj rebuild` restores the
table AND everything a revert would put back, without the DB. Blobs are
inlined because a readable tree is source text and the family is git-tracked;
externalising them for very large trees is a follow-up, not an integrity
question. The `log/` entries are a derived tail emitted from the table after
the annotation history (spec 18 section 9), which is why `rebuild` skips them.

**Binding-id traceability.** The chain is
`{fn,reg} binding id -> module index -> BindingOrigin -> EmittedFile.origins -> path`.
Following it backwards from any file in the readable tree reaches the bytecode
it came from, however many combines and splits happened in between. Zero orphans
is a structural property enforced at write time by `validateTransaction`, not a
statistic measured afterwards.

**Names are overlay transactions (docs/PUSHBACK.md P-59).** A NAME proposal
never enters this table: `EmittedFile.path` is a real path in `treeDir`, and
a name has no tree file at the point it is proposed. The name-overlay
(`NameService`/`OverlayStore`, the rename tool's own storage) is the
transaction log for names -- its append-only supersession chain gives the
same reversibility and provenance guarantee this section gives file ops,
just over `{fn,reg}` bindings instead of paths: `OverlayStore.revert`
restores the immediately-prior `NameRecord` exactly (byte-identical render,
proved by section 9.4's NAME-row backstop), and every record already carries
its own `source`/`gate` provenance stamp. `list_suggestions` (section 9.7)
reads both this table and the overlay and returns one merged list;
`promote_change`/`revert_change` take a `suggestionId` (the overlay record's
`rid`) for a name, `txId` for anything in this table.

### 9.6 Evaluator plug-in interface (section 1d.1)

Correctness is always the equiv oracle and is never pluggable. QUALITY review
is, and it is **opt-in and not hard-wired to any model**.

- `EvaluationMode` is `human-ui` | `agent` | `inline-caller` | `none`.
- `evaluationModeFor({surface, requested})` picks it: the `ui` surface ALWAYS
  returns `human-ui` (a human is present; never spawn an evaluator, even if one
  is requested), and `mcp`/`cli` return whatever the caller wired, defaulting to
  `none` -- raw `suggested` + equiv-verified results for the caller to judge.
  **The human UI review is the default**; automated evaluation is the thing a
  caller must ask for.
- `EvaluatorPlugin` is `{ id, mode, evaluate(items, signal) -> EvaluationReport }`.
  Any object with those three members is a legal evaluator: a spawned agent on
  any model, the calling agent grading inline, or an offline heuristic. The
  report is judgements only -- **it has no promotion field**, because an
  evaluator annotates and never promotes (D28-1).
- The grading primitive is `QualityRater` (`{ id, rate(target, proposedName) }`)
  over a `LabelledSample`. The shipped default, `ReferenceNameRater`, is offline
  and deterministic: accurate when the proposal normalises to the reference name
  or an accepted alternative; **misleading** when a security-relevant target
  gets a name that is not its reference (the class section 7 requires zero of);
  inaccurate otherwise.
- **Labelled-sample format** (`LabelledSample`): `{app, bundle, labelledBy,
  labelSource, ts, targets[]}` where each target is
  `{id, kind: module|function|register, source, referenceName, alsoAccept[],
  role?, securityRelevant, note}`. The label is GROUND TRUTH about the target,
  not a judgement of one proposal, so one sample grades any backend. The shipped
  sample for the held-out app is
  `tests/fixtures/llm-readability/react-navigation-example-0.85.3.labels.json`
  (12 targets, labels derived from the bundle's own committed sourcemap, one
  security-relevant). The gate re-checks every `source` against that sourcemap,
  so a stale label fails rather than rots. Register-level labels are added in
  landing 1 from `react-navigation-example.debug.hbc`, which carries debug info.

**Landed (landing 5)**: `src/readability/evaluate.ts` is the plug-in host.
`runEvaluation(items, plugin, signal?)` hands a batch of `EvaluationItem`s to
`plugin.evaluate` and returns the `EvaluationReport` UNCHANGED -- it takes no
DB/tier argument at all, so it cannot promote by construction. Three shipped
plugins: `NONE_PLUGIN` (mode `none`, empty report); `createInlineCallerPlugin()`
(mode `inline-caller`, no backend call at all -- every item comes back with a
`pending-caller` verdict, a fourth `RaterVerdictKind` alongside
`accurate`/`inaccurate`/`misleading`, for the calling agent to overwrite after
grading inline); `createAgentEvaluatorPlugin({backend, id?})` (mode `agent`,
one `evaluate` job-kind call per item, `hbc-evaluate` skill, any
`WorkerBackend`). The adversarial re-check (section 1b step 8) is
`needsAdversarialRecheck`/`runAdversarialRecheck`/`applyAdversarialDemotion`
in the same file: a target flagged `securityRelevant`, or `high` confidence
with `reach` over `ADVERSARIAL_REACH_THRESHOLD` (20), gets one more call on
the `adversarial-recheck` job kind with the `hbc-adversarial` skill; a
`misleading` verdict demotes the proposal to `low` confidence and prefixes its
evidence with `[flagged: misleading]` (docs/PUSHBACK.md P-59 means a NAME
proposal has no transaction row to carry a first-class `flagged` field yet, so
the marker lives in the evidence text the suggestion pane already shows).
`name-pass.ts`'s `runNamePass` runs the re-check inline (before its own equiv
backstop) when `opts.adversarial` is wired, using `OverlayStore.demote` (an
in-place confidence/evidence patch, no new revision) so the demotion stays
inside the same batch write the backstop already tracks. The CLI hook is
`hbc2js readability review <input.hbc> --adversarial` (section 9.7). Two new
`JobKind`s (`evaluate`, `adversarial-recheck`) and their skills are P-60.

### 9.7 Surfaces

One core, three callers; no caller bypasses the oracle or the DB trace.

```text
MCP tools: suggest_names, rewrite_function, classify_module, file_op, promote_change, revert_change, list_suggestions
CLI verbs: name llm-fill, readability rewrite, readability file-op, readability review
UI actions: suggest names for this module, make this function readable, combine these files, review suggestions
```

`promote` and `revert` already exist on the spec-17 MCP surface with different
argument shapes, so the readability verbs are `promote_change` / `revert_change`
rather than overloading them. The names above are pinned in code
(`READABILITY_MCP_TOOLS`, `READABILITY_CLI_VERBS`, `READABILITY_UI_ACTIONS`) and
the gate asserts the spec text and the code agree, so a landing cannot rename a
tool without editing this section in the same commit.

**MCP argument shapes** (landing 4):

| tool | arguments | returns |
| --- | --- | --- |
| `suggest_names` | `{target: {fn} \| {module}, budgetTokens?, evaluate?: EvaluationMode}` | `{suggestions: NameProposal[], equiv: EquivProof, txIds: string[], evaluation?: EvaluationReport}` |
| `rewrite_function` | `{fn, budgetTokens?, evaluate?}` | `{rewrite?: RewriteProposal, equiv: EquivProof, accepted: boolean, txId?}` |
| `classify_module` | `{module, evaluate?}` | `{role?: ModuleRole, path?: string, confidence, evidence, txId?}` |
| `file_op` | `{op: make\|rename\|move\|combine\|split, inputs: BindingOrigin[], outputs: {path}[], evidence}` | `{txId, equiv: EquivProof, accepted: boolean}` |
| `promote_change` | `{txId \| suggestionId, who}` | `{txId, tier: "confirmed"}` -- refuses a `worker:` `who` |
| `revert_change` | `{txId}` | `{txId, revertedTxId, restored: {path, sha256}[]}` |
| `list_suggestions` | `{filter?: {tier?, confidence?, module?, securityRelevant?}, limit?}` | `{suggestions: [...], total}` |

Every one of them returns equiv-verified, DB-tracked, `suggested`-tier results:
an external agent gets exactly the same safety as the UI and cannot push an
unverified or untraced change.

**UI actions** use the spec 22-26 vocabulary: the actions above enqueue spec-23
jobs and their results land in the suggestion pane with evidence, confidence,
equiv status and a before/after diff, with batch promote/revert filters and
reach ordering (section 1d).

**CLI**: `hbc2js name llm-fill <project> [--kinds ...] [--only src]
[--budget-tokens N] [--backend haiku]` for the batch pass;
`readability rewrite|file-op|review` for the function, tree and queue
operations. Both batch and live are supported (D28-2). `readability review`'s
own argument shape is landing 5's invention (the spec pinned only the verb
name, section 9.7's `READABILITY_CLI_VERBS`, not a table): `hbc2js
readability review <input.hbc> [--adversarial] [--security-relevant
fn:reg,...] [--backend haiku|replay|heuristic] [--recording <file>] [--store
<path>] [--json]` lists the overlay's `source:"llm"` suggestion queue and,
with `--adversarial`, runs the section 1b step 8 re-check over it (P-60).

## 10. Landing plan

Five landings. Each names its files, its tests, and one exit criterion. No
landing may make a test from an earlier landing skip again.

### Landing 1 -- naming path: HaikuBackend + skills + equiv gate

- **Files**: `src/workers/backends/haiku.ts` (new); `src/readability/cache.ts`
  (new); `src/readability/name-pass.ts` (new: gather -> cache -> skill ->
  generate -> validate -> write overlay -> equiv backstop); `skills/hbc-name.md`,
  `skills/hbc-classify.md` (shipped with this spec); `src/cli.ts`
  (`name llm-fill`); a replay/recorded backend for the gate.
- **Tests**: `coverage.test.ts` (both legs), `quality.test.ts` (the >= 80%
  leg), `cost-cache.test.ts` (both legs), `fidelity-reversibility.test.ts`
  (the fidelity leg) all stop skipping and go green.
- **Exit criterion**: on the held-out app, >= 70% of `src/` registers and
  >= 80% of `src/` modules carry a non-`rN`/non-`module_N` name; apply-then-revert
  is byte-identical; a second run costs <= 10% of the first.

**Status: LANDED (plumbing) 2026-09-11.** `HaikuBackend` (plain `fetch`, no
SDK), `src/readability/cache.ts`, `src/readability/name-pass.ts` (the shared
gather-free loop: cache -> skill -> generate -> validate -> write -> equiv
backstop), `src/workers/backends/replay.ts`, `tools/readability/record.ts` and
`hbc2js name llm-fill` all ship. `coverage.test.ts`/`quality.test.ts`'s
held-out-app ratio legs stay skipped with the exact message naming the missing
recording (`tests/fixtures/llm-readability/react-navigation-example-0.85.3
.recording.json`, produced by `tools/readability/record.ts` with
`ANTHROPIC_API_KEY`, which this landing's agent does not have) -- that is the
one exit-criterion number NOT yet measured. Every other landing-1 leg is real
and green: `fidelity-reversibility.test.ts`'s fidelity leg (apply-then-revert
byte-identical, on a construct fixture rather than the 15,551-function
held-out app -- that bundle's full `rawFrameBodies`/`render()` pass exceeds the
gate's time budget; the held-out-app version of this same property belongs in
`tests/sweep/`, not measured yet), `cost-cache.test.ts`'s both legs (a stubbed-
`fetch` HaikuBackend cache-hit measurement and a `FakeBackend` budget-stop),
and `name-pass.test.ts`/`backends.test.ts` (new, `tests/gate/llm-readability/`
and `tests/workers/`) proving the loop end to end: gate-refusal, abstention,
malformed output, and the batch equiv backstop's PASS/DIVERGENT paths.
Measured on a construct fixture (`04-for-loop-basic`) with `FakeBackend`: 8/16
nameable registers named in one pass, apply-then-revert render byte-identical,
0 orphaned/half-written targets across a budget-stopped run. The 12-target
synthetic recording (`tests/fixtures/llm-readability/synthetic.recording
.json`) proves the `ReplayBackend` path the same way a real recording would.
Real per-run coverage/cost numbers on NSW or the held-out app need the
recording or `HBC2JS_NSW_HBC`, neither available to this landing's agent --
queued as this landing's one follow-up, not a correctness gap.

**1b status: LANDED (backend), smoke INCONCLUSIVE, 2026-09-11.**
`src/workers/backends/claude-cli.ts` (`ClaudeCliBackend`, the new DEFAULT),
`resolveClaudeCliConfig`/`ClaudeCliBackendConfig` (`src/readability/types.ts`),
`src/readability/backends.ts` (`backendForId`/`resolveBackendId`, the one
id-to-constructor map `hbc2js name llm-fill`, `tools/readability/record.ts`
and the UI worker pool all resolve through), and the UI pool's
`buildUiBackend`/`RoutedWorkerBackend` (`src/ui-server/server.ts`, routing
`SKILL_FOR_KIND`'s job kinds to the LLM backend and everything else to
`HeuristicBackend`) all ship, with 12 stub-driven tests
(`tests/workers/claude-cli-backend.test.ts`, `tests/support/stub-claude.mjs`)
covering argv/stdin construction, JSON/usage parsing, cache-hit skip,
`is_error`/non-zero-exit/timeout/missing-binary/malformed-JSON ->
`TransientBackendError` vs `ReadabilityConfigError`, `max_tokens` as a
rejected candidate not a throw, and the same `cacheKey` shape as
`HaikuBackend`. The section 10 exit-criterion smoke (item 5 of the landing
brief, `node tools/readability/record.ts react-navigation-example.hbc ...
--backend claude-cli --limit 5`) did NOT produce a recording: both allowed
real-CLI attempts failed (`docs/BUGS.md`, 2026-09-11 row) --
`spawn E2BIG` (fixed in this commit: the prompt moved from an argv token to
stdin, since a rendered function's source can exceed the OS argument limit),
then an unhandled `EPIPE` writing to a child that closed its stdin before
reading it (also fixed in this commit: a `child.stdin` error handler, plus a
regression test for each crash). Zero tokens were spent on the first attempt
(the child process never started); the second attempt's token/cost numbers
were not recovered because the crash happened before the backend could parse
a response. Whether the real `claude` build actually reads a large `-p`
prompt from stdin at all is still open (`docs/BUGS.md` row, cluster
`toolchain`) -- the fix makes both failure modes safe (a clear
`TransientBackendError`/no crash) but does not by itself prove stdin delivery
works; that needs one more real invocation, budgeted to the next agent
touching this file.

**Held-out recording, bounded, 2026-09-11.** `tools/readability/record.ts`
used to walk every function of the bundle (~15k on the held-out app) to build
the recording above -- unbounded cost/time for this section's own "src/
registers"/"src/ modules" targets, which are a much smaller population.
`src/readability/scope.ts` (`computeSrcScope`, new) reuses the exact
`splitProject` -> `segregateSplitTree` classifier path `hbc2js segregate`
uses (spec 08) to bound `record.ts` to functions in a `src`-bucket module;
`record.ts` gained `--only src`, a deterministic `--sample N [--seed S]`
reservoir sample for a bounded smoke run, and `--resume` (skips a target
whose cache key is already in the output file, so a rate-limited run can
continue without re-spending tokens). The orchestrator runs the real
held-out recording with:

```
node tools/readability/record.ts <held-out.hbc> \
    tests/fixtures/llm-readability/react-navigation-example-0.85.3.recording.json \
    --backend claude-cli --only src --resume
```

Measured with `--backend fake` (no model call) on the held-out app itself,
react-navigation-example-0.85.3: `--only src` selects 345/1782 modules; see
`docs/AGENT-LOG.md` for the exact target/function count from that dry run.
Tests: `tests/gate/llm-readability/record-scope.test.ts` (no network,
`--backend fake`/hand-built recordings only).

### Landing 2 -- rewrite path (function-level, equiv-gated)

- **Files**: `src/readability/rewrite.ts` (candidate rewrite -> parse -> render
  -> `equiv --hbc` on the affected function, with fuzzed inputs per spec 09);
  `skills/hbc-name.md` gains a rewrite section or a fourth skill is added,
  whichever review prefers.
- **Tests**: a rewrite acceptance test per class (accepted rewrite, rejected
  DIVERGENT rewrite, rejected unparseable rewrite, rejected INCONCLUSIVE), each
  asserting the faithful original is what survives a rejection.
- **Exit criterion**: on construct fixtures, every accepted rewrite passes
  `equiv --hbc` and every rejected one leaves the faithful output untouched;
  zero accepted rewrites with an INCONCLUSIVE proof.

**Status: LANDED 2026-09-11.** `src/harness/hbc-equiv.ts` (the oracle:
`hbcVsJsUnderHermes` + `runFunctionEquiv`, 7 tests in
`tests/gate/harness/hbc-equiv.test.ts`), `src/readability/rewrite.ts`
(`spliceRewrite` / `gateRewrite` / `runRewritePass` + the change record, 10
tests in `tests/gate/llm-readability/rewrite.test.ts`), and
`hbc2js readability rewrite` (3 tests in
`tests/gate/cli/readability-rewrite.test.ts`, the section 9.7 verb, candidates
read from a file so the gate never calls the network). Measured on construct
fixture `04-for-loop-basic` v84 through the real Hermes VM: an equivalent
restatement of `_fn0` is ACCEPTED with a PASS proof over 8 observed output
lines; the same function with one extra `print` is REJECTED_DIVERGENT; an
unparseable candidate is REJECTED_PARSE without the oracle running at all; an
INCONCLUSIVE proof is refused exactly like a divergent one. Zero accepted
rewrites carry a non-PASS proof (asserted over every attempt the file makes),
and every rejection returns the faithful render byte for byte.

Two deviations from the landing plan, both recorded: the **skill file is
deferred** (docs/PUSHBACK.md P-57 -- bumping `skills/hbc-name.md` to version 2
invalidates every key in the committed replay recording, and re-keying a
fixture is a snapshot regeneration an implementation task may not do; the
rewrite prompt contract is documented in `docs/READABILITY.md` instead, and the
skill lands with the next recording regeneration), and an accepted rewrite is
stored as a **`RewriteChangeRecord`** rather than a `ReadabilityTransaction`
(docs/PUSHBACK.md P-58 -- section 9.5's `op` enum has no value for "rewrote one
function"; the record carries every other field and the same validation rules,
and landing 3 maps it in).

### Landing 3 -- DB transaction log + file ops -- LANDED (2026-09-11)

- **Files**: `src/readability/transactions.ts` (`commitTransaction` /
  `recordTransaction` / `revertTransaction` / `listTransactions` /
  `traceFile` / `traceAllEmitted`); `src/readability/file-ops.ts` (make /
  rename / move / combine / split + the two-leg tree gate);
  `src/projdb/readability-shards.ts` (the shard family, the log tail, the
  shards->DB restore); schema minor 6 (`readability_tx`, `readability_blob`);
  `export`/`rebuild`/`verify` and the `hbcproj` CLI learn the family.
- **Tests**: `fidelity-reversibility.test.ts`'s reversibility, traceability and
  tree-equiv legs stopped skipping, plus
  `tests/gate/llm-readability/transactions.test.ts` (9),
  `tests/gate/llm-readability/file-ops.test.ts` (9) and
  `tests/projdb/readability-shards.test.ts` (3).
- **Exit criterion, measured** on the fixture trees
  (`tests/support/readability-tree.ts`: a two-module split tree whose bodies
  are the real decompile of construct fixture `04-for-loop-basic`). Over a
  four-op pass (make, rename, move, combine): **5/5 emitted files have >= 1
  origin, 0 orphans (100%)**; **4/4 transactions reverted restore the prior
  tree hash exactly (100%)**, as do the 3 ops of the file-ops pass and a
  revert-of-a-revert; **4/4 accepted transactions carry a `scope: "tree"`
  PASS proof** and `validateTransaction` returns no problems for any of them.
  A DIVERGENT or INCONCLUSIVE verdict leaves the tree byte-for-byte untouched
  and writes nothing -- measured by tree hash, not asserted by construction.
- **Open follow-up (same shape as landing 1's)**: the held-out-app version --
  a full file-op pass over a real 15k-function decompile with the SHIPPED
  oracle and a real Hermes VM -- belongs in `tests/sweep/` behind
  `requireSweep`, not the 2-minute gate. The gate proves the gate: the
  structural leg is the shipped one, the behavioural leg is injected, and
  `file-ops.test.ts` proves a non-PASS verdict refuses. That is this
  landing's one open follow-up, not a correctness gap.

### Landing 4 -- MCP tools + UI actions

- **Files**: `src/readability/surfaces.ts` (the seven MCP tools, argument
  validation, and the UI action bindings); `src/mcp/tools.ts` registration;
  the spec 22-26 suggestion pane gains evidence / confidence / equiv-status
  columns and the batch promote/revert filters.
- **Tests**: `surfaces-evaluator.test.ts`'s registration leg stops skipping; one
  round-trip test per tool.
- **Exit criterion**: an external agent driving only MCP can suggest, review,
  promote and revert, and cannot produce an unverified or untraced change --
  shown by a test that tries and is refused.

**Status: LANDED (core) 2026-09-11.** `src/readability/surfaces.ts` (the seven
functions over a `ReadabilityContext`), `src/mcp/tools.ts`'s
`registerReadabilityTools`/`READABILITY_TOOL_SCHEMAS`/`validateReadabilityArgs`
(spec-17's `promote`/`revert` untouched), 6 round-trip tests in
`tests/gate/llm-readability/surfaces.test.ts` (one per tool plus the exit
criterion, all against `FakeBackend`/stub oracles, no network, no real Hermes
VM) and 4 in `tests/mcp/readability-tools.test.ts` (schema validation +
registration). `surfaces-evaluator.test.ts`'s registration leg stops skipping
and asserts a real round trip through the registered handlers. Exit criterion
MET on construct fixture `04-for-loop-basic`: a driver using only
`surfaces.ts` suggests a rewrite, lists it in the review queue, is REFUSED
promoting it as `worker:haiku`, promotes it as a human, reverts it, and is
separately REFUSED (b) a DIVERGENT rewrite (never reaches a transaction) and
(c) a zero-origin `file_op` (refused before the tree is touched).

**One deviation, recorded**: `suggest_names`/`classify_module` do not write
into the `readability_tx` table -- `txIds`/`txId` come back empty/`undefined`
(docs/PUSHBACK.md P-59, resolved: the transaction log's `EmittedFile.path` is
a real tree file, and a NAME/classification proposal has none yet at this
stage, so both write through the name-overlay's own supersession chain
instead, addressed by `suggestionId`). Both are still equiv-verified (the
section 9.4 NAME-row backstop) and reviewable. `rewrite_function` and
`file_op` have no such gap.

**Status: LANDED (UI) 2026-09-11.** `src/ui-server/readability-routes.ts`
puts `list_suggestions`/`promote_change`/`revert_change` and the four section
9.7 UI actions on HTTP (`GET /api/readability/suggestions`, `POST
/api/readability/{promote,revert}`, `POST /api/readability/actions/
{suggest-names,rewrite-function,combine-files,review}`), spliced into
`src/ui-server/routes.ts` the same way the spec-23 worker routes are.
`ui/src/workers/readability-wire.ts`/`readability-hooks.ts` are the client;
`ui/src/panes/WorkersPane.tsx` gains a "Readability" section (a different
pipeline from the jobs rail above it in the same pane, not a parallel pane):
tier/confidence/module/security-relevant filters, a suggestion list with
confidence/evidence/equiv-status columns (the equiv verdict, oracle and scope
on hover), a before/after path panel for `rewrite` transactions, per-row and
batch promote/revert over the current filter, reach ordering (module-order
fallback -- no xref caller-count reaches this pane yet, docs/BUGS.md), and
the four UI actions in the section header. 8 server-route tests
(`tests/ui-server/readability-routes.test.ts`) and 6 DOM tests
(`ui/src/panes/WorkersPane.readability.dom.test.tsx`).

Two things this pass did NOT build, recorded rather than silently dropped
(both since resolved -- see the diff-content fix below this paragraph and
landing 4d's P-61 resolution further down): (1) **PUSHBACK P-61**: the four
actions ran to completion and answered directly instead of enqueuing a
pollable `JobRow` -- `JOB_KINDS`/`WorkerRunner` (spec 23) had no
readability-aware branch, and extending them was out of this task's file
scope. (2) a true before/after **text** diff for a rewrite transaction:
`EmittedFile`/the transaction's `prior` carried paths and hashes, not
rendered content, so the panel showed paths/hashes only. Combine files'
file list is STILL a manual comma-separated input, not the tree's own
multi-select (no route into `ui/src/panes/LeftPane.tsx`'s tree selection --
an interaction design call for Fred, unresolved). The P-57 skill-file batch
is unrelated prior work, already landed.

**Diff content fixed 2026-09-11 (docs/BUGS.md resolved).** `GET /api/
readability/suggestions` now enriches each `tx` item with `priorContent`/
`newContent` (rendered text, keyed by path) -- `prior` reads the DB-held
blob the transaction log already keeps for `revert` (`readBlob`, keyed by
the recorded sha256); `new` reads whatever `treeDir` currently holds at
each output path. Response-only enrichment in `readability-routes.ts`; the
`ReadabilityTransaction` shape itself (`src/readability/types.ts`) is
unchanged, per the design constraint. The pane's before/after panel
(`WorkersPane.tsx`) renders the text when present, falling back to path +
hash otherwise. Same commit applied the `securityRelevant` filter
`list_suggestions` had accepted but never used (`NameRecord`/`NameMeta`
gained the field, threaded from `NamePassTarget`).

**Status: LANDED (live wiring) 2026-09-11 (landing 4d).** `src/ui-server/
server.ts` now builds a real `ReadabilityRoutesCtx` for a real `hbc2js
ui-server` process: ONE project-db connection is opened up front and shared
between the spec-23 worker pool (`startWorkers`, refactored to take the
already-open `db` rather than opening its own) and the new
`buildReadabilityCtx`, which points `treeDir` at `<projectDir>/src` (the
split tree `init`/`--split` always write there), `hbcPath` at `--hbc`, and
the backend at a NEW `--llm-backend <id>` CLI flag (mirrors
`HBC2JS_LLM_BACKEND`, `--llm-backend` wins when both are given) --
independent of the worker pool's own `HBC2JS_LLM_BACKEND` routing, so a rig
can pin `fake`/`heuristic` for readability without changing the ordinary
job pool's backend. No readable tree at `<projectDir>/src`, no project db,
or an invalid backend id all yield the same "absent, not faked" 503 the
pane already handles -- never a crash. Proved by `tests/ui-server/
server-readability.test.ts` (3 tests) starting the real server over a real
socket and hitting every readability route.

**PUSHBACK P-61 resolved 2026-09-11.** `JOB_KINDS` (`src/workers/queue.ts`)
gained `readability-suggest-names`/`readability-rewrite-function`/
`readability-combine-files`; `WorkerRunner` (`src/workers/runner.ts`) gained
`runReadabilityJob`, dispatching those three kinds straight to
`src/readability/surfaces.ts` over a new optional `readability` ctx (never
through a `WorkerBackend` prompt -- the surfaces call the backend
themselves, same as before). `src/ui-server/readability-routes.ts`'s three
WRITE actions now `enqueue` through the SAME `JobQueue`/`WorkerRunner`
`/api/jobs` uses and answer `202 {jobId}` instead of running to completion
inline; `ui/src/workers/readability-wire.ts` polls `/api/jobs` internally
(the same jobs rail the "AI" tab's other buttons already poll), so
`readability-hooks.ts` and `WorkersPane.tsx` needed NO shape change --
`suggestNamesAction.mutate(...)` still resolves with the surface's own
result once the job is done. `review` (section 9.7: "opens the queue; no
job") is unchanged, still synchronous. Tests: `tests/workers/runner.test.ts`
(+3: dispatch, malformed-input failure, no-readability-context failure),
`tests/ui-server/readability-routes.test.ts` (+1, the other 8 updated to
drive the enqueued job to completion via `runner.runOne()`),
`tests/ui-server/server-readability.test.ts` (updated: `202` + polling the
REAL background pool over a real socket).

**Playwright coverage landed** in `ui/e2e/readability.spec.ts` (3 tests)
against the fixture rig with `HBC2JS_LLM_BACKEND=heuristic` (already pinned
by `playwright.config.ts`): the section renders under the AI tab, `Review`
completes synchronously and deterministically (a fresh project starts with
zero suggestions), and `Suggest names` is proved live by asserting the
ENQUEUE (a real `readability-suggest-names` job appears in `/api/jobs`),
not the ~70s cold completion -- see that file's header for the full
reasoning, including a real PERFORMANCE FINDING it surfaced: a cold
`suggest_names`/`rewrite_function`/`classify_module` call re-parses and
re-analyses the WHOLE `.hbc` file every time (`loadAnalysis`, no cache),
measured at 72s wall on this rig's own 435-module fixture bundle
(`docs/BUGS.md`, open, out of this landing's scope). Running this suite
alongside the existing `ai-suggestions.spec.ts` also surfaced a real,
pre-existing selector collision (`getByRole("button", {name:"Suggest
name"})` inexact-matching the new "Suggest names" button once both ship in
the same "AI" tab) -- fixed in `ai-suggestions.spec.ts` with `exact: true`.
The brief's full suggestion-row/promote/revert/tier-flip round trip needs a
real LLM backend (out of scope for a CI rig) or a pre-seeded transaction;
that round trip is already proven browser-free in
`tests/gate/llm-readability/surfaces.test.ts`'s exit-criterion test and
`tests/ui-server/readability-routes.test.ts`'s promote/revert test.

### Landing 5 -- evaluation loop

- **Files**: `src/readability/evaluate.ts` (the plug-in host, mode selection,
  the adversarial re-check of section 1b step 8); optional `skills/hbc-doc.md`
  (D28-3) if naming has cleared its targets.
- **Tests**: `surfaces-evaluator.test.ts`'s loop leg and `quality.test.ts`'s
  security clause stop skipping.
- **Exit criterion**: with `evaluate: agent` requested over MCP, a report comes
  back, nothing is promoted by it, and the adversarial re-check drives
  `misleading` verdicts on security-relevant targets to zero.

**Status: LANDED 2026-09-11.** `src/readability/evaluate.ts` (section 9.6's
narrative above has the full shape: `runEvaluation`, `NONE_PLUGIN`,
`createInlineCallerPlugin`, `createAgentEvaluatorPlugin`, and the adversarial
re-check trio). `evaluate?` is wired through `suggest_names`,
`classify_module` and `rewrite_function` in `src/readability/surfaces.ts`
(`ReadabilityContext` gains `surface?`/`evaluator?`; `maybeEvaluate` applies
section 9.6's mode selection, so a UI context can request `evaluate: "agent"`
and nothing is ever spawned -- tested). `name-pass.ts`'s `runNamePass` gained
`opts.adversarial` and two `NamePassTarget` fields (`securityRelevant?`,
`reach?`); the CLI gained `hbc2js readability review [--adversarial]`.
`skills/hbc-evaluate.md` and `skills/hbc-adversarial.md` ship (D28-3's
`hbc-doc` stays deferred -- naming coverage has not cleared section 7 without
the held-out recording, landing 1's own open follow-up, so this landing does
not attempt it, exactly as section 8 anticipates).

Measured on `tests/fixtures/llm-readability/react-navigation-example-0.85.3
.labels.json`: a planted misleading proposal on the sample's one
security-relevant target (`rn-ex-08`, the deep-link URL intake) trips
`highConfidenceAccuracy`'s `misleading` counter to 1 before any recheck; a
`FakeBackend` adversarial pass that catches the plant demotes it to `low`
confidence, and `misleading` measures 0 afterward -- section 7's clause,
exercised end to end with no network. `surfaces-evaluator.test.ts`'s loop leg
and `quality.test.ts`'s security clause both stop skipping with real
assertions, not weakened ones. Two new job kinds (`evaluate`,
`adversarial-recheck`) and the `readability review` argument shape are
docs/PUSHBACK.md P-60 (open): the backend interface routes a skill from the
job kind alone, so a second question needs a second kind, and the CLI verb
had no argument table in the spec to begin with.

## 11. Acceptance tests shipped with this spec

`tests/gate/llm-readability/`, written before any implementation, in the spec-13
convention: what can run today is GREEN, what needs a landing is RED-SKIPPED
with the landing number in the skip message, and nothing is green by
construction.

| file | green today | red-skipped until |
| --- | --- | --- |
| `interface-shape.test.ts` | config defaults, env precedence, validation refusals, skill routing, "no transport in `src/readability`, no model SDK in `package.json`" | - |
| `skills.test.ts` | every shipped skill loads, parses, declares its kind, and carries all four sections; the naming skills' output contract is checked against the `NameProposal` wire shape, the landing-5 evaluator/adversarial skills' against their own `{verdict,rationale}` shape; malformed skills refused; `hbc-doc` absent | - |
| `backend-roundtrip.test.ts` | a `suggest-name` job round-trips skill + context through `FakeBackend` into proposals; abstain; malformed output rejected not thrown; evidence-free `high` downgraded | - |
| `cost-cache.test.ts` | cache key is content-addressed, every field participates, cannot be forged by moving content between fields | landing 1 (the >= 90% re-run measurement, the budget stop) |
| `coverage.test.ts` | the two targets are pinned in code | landing 1 (both legs). The NSW leg additionally skips with a clear message unless `HBC2JS_NSW_HBC` points at the bundle, which is proprietary and never committed |
| `quality.test.ts` | sample format conformance, every label traced to the held-out app's sourcemap, rater verdicts, accuracy arithmetic including a FAILING run and the empty case; landing 5's security clause (a planted misleading proposal on the sample's security-relevant target, demoted to zero after the adversarial re-check) | landing 1 (the >= 80% measurement -- still needs the held-out recording) |
| `fidelity-reversibility.test.ts` | transaction validity: orphan files, missing inputs, non-reversible ops, non-PASS proofs, worker self-promotion; INCONCLUSIVE is never PASS; landing 1's apply-then-revert byte identity; landing 3's revert exactness, traceability and tree-equiv legs | - (all legs green) |
| `surfaces-evaluator.test.ts` | spec-text/code vocabulary agreement for all three surfaces, snake_case and non-collision of tool names, evaluator mode defaults, plug-in round-trip with no promotion field; landing 5's loop leg (an MCP `suggest_names` call with `evaluate:"agent"` returns a report that touches no transaction, and the `ui` surface never spawns the same wired plugin) | - (all legs green) |

Landing 5 shipped `tests/gate/llm-readability/evaluate.test.ts` (mode
selection table, all three plugins round-tripped, report-has-no-promotion-
field structurally, the adversarial re-check's gating/demotion, and section
7's clause over the labelled sample), plus regression tests in
`tests/gate/llm-readability/name-pass.test.ts` (the re-check wired into
`runNamePass`), `tests/gate/name-overlay/store.test.ts` (`OverlayStore.demote`,
the in-place patch the re-check's same-batch correction relies on) and
`tests/gate/cli/readability-review.test.ts` (the new CLI verb, including one
full replay-backend round trip that demotes a planted misleading name).

Landing 3 shipped `tests/gate/llm-readability/transactions.test.ts`,
`tests/gate/llm-readability/file-ops.test.ts` and
`tests/projdb/readability-shards.test.ts`, with the fixture tree builder in
`tests/support/readability-tree.ts`.

Landings add their own acceptance files alongside these: landing 2 shipped
`tests/gate/llm-readability/rewrite.test.ts` (one test per rejection class plus
the cross-cutting "no accepted rewrite carries a non-PASS proof"),
`tests/gate/harness/hbc-equiv.test.ts` and
`tests/gate/cli/readability-rewrite.test.ts`.

No test asserts exact decompiler output on a shared fixture
(`docs/CONSOLIDATION.md` section B item 7); the only fixture-derived assertions
are structural (a sourcemap contains a path) or over a rung-private JSON sample.

## Review responses

### R1. Draft section 1 vs Fred's section 0a (resolved in favour of 0a)

Section 1 says "the LLM **never rewrites code or changes semantics** ... only
proposes labels". Section 0a, written later the same day and marked as Fred's,
says the opposite: rewrites are allowed as long as they pass the oracle. The
spec is promoted with **0a governing**: rewrites are in scope (landing 2),
naming is the conservative subset that lands first (landing 1), and section 1's
truth-first machinery (overlay, provenance, confidence, reversibility,
promotion gate) applies to both. Section 1's title is accurate for the naming
subset and is left as written rather than edited, since it is the enumeration of
the truth-first enforcement mechanisms. Recorded as `docs/PUSHBACK.md` P-54.

### R2. `--budget-usd` vs tokens

Sections 1b and 3 say `--budget-usd`; section 6 and the project convention say
tokens, not dollars (`docs/AGENT-LOG.md` is tokens-not-dollars). Settled on
**tokens**: the config field is `budgetTokens`, the CLI flag is
`--budget-tokens`, and USD never appears in a config or a job record. A dollar
figure is a reporting convenience computed from tokens at a stated rate, not a
control input. Recorded as P-55.

### R3. MCP `promote` / `revert` collision

Section 1e lists `promote(id)` and `revert(id)`. Both names are already taken on
the spec-17 MCP surface with different argument shapes, so the readability verbs
are `promote_change` and `revert_change` (9.7). Recorded as P-56.

### R4. What "held-out" means here

`tests/fixtures/bundles/react-navigation-example-0.85.3` is held out in the only
sense available in-repo: the skills were written without reading its decompiled
output, and its labels come from its own committed sourcemap rather than from
any model. It is NOT held out from the repo, and a future landing that tunes a
skill against it must say so and pick a new held-out app. Stated here so the
claim in section 7 is not read as stronger than it is.
