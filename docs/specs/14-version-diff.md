# 14 — Version diff: two decompiles of the SAME app, keyed to stable ids (P2.5)

**Status: SPEC (2026-09-04, Fable). Review gate required before implementation
(decision 8).**

**Stage-2 success criteria apply IN ORDER (docs/QUEUE.md Stage 2): (1) TRUTH,
then (2) EFFICIENT TO USE.** Concretely for this spec: a function match is
never guessed — every match carries a confidence tier, tiers below the bar are
*candidates* phrased as candidates, and an unmatched function is reported
unmatched rather than force-paired; a removed-check row is a **lead**, never a
claim; annotation re-binding below the exact tier is FLAGGED for a human/LLM
decision, never applied. Only then does every verb get a hard output bound so
the loop spends its context on the delta, not on re-derivation.

Consumes ONLY the P2.1 artifact (spec 10) — two of them — plus the P2.2
project store (spec 11) for orphan re-binding and the P2.3 classifier (spec
12) for the endpoint view. It never imports `src/parse`/`src/cfg`/`src/emit`
directly (spec 10 header rule); the one thing it needs that the artifact does
not yet carry (per-function bytecode signatures, §2) is added to the artifact
as an **additive** semantic-index file under spec 10's extension mechanism
(§6 there: "the schema header's `kind` registry is the extension mechanism"),
not computed by reaching into internals at diff time.

Self-contained for consumers: an analyst or the P2.7 loop needs this document
and the verbs in §5, nothing else. Implementers additionally read §9.

## 0. What a vuln analyst asks of a version bump

v1.2.3 shipped; v1.2.4 just shipped. The questions, in the order they pay:

1. **What code changed?** New functions, removed functions, changed functions
   — with the noise of `fnIndex` renumbering (spec 10 §6: fnIndex is NOT
   stable across app versions) removed, honestly.
2. **Did a check disappear?** A function that lost a guard between versions is
   the classic silent-vuln lead (auth check dropped, input validation relaxed,
   cert-pinning branch removed).
3. **What does it talk to now?** New/removed endpoints, strings, native/bridge
   calls — the surface delta.
4. **What did I already know?** Every annotation made on v1.2.3 (names, tags,
   comments, findings) re-attached to the v1.2.4 code it describes — at the
   confidence the match deserves, and flagged, not guessed, below that.

```
artifact(old)  ──┐
                 ├── hbc2js diff build ──► <new>/diff/<pairId>/
artifact(new)  ──┘        │                  match.jsonl   (the fn map, tiered)
                          │                  report.json   (summary counts)
project store  ◄── rebind (exact only) ──── leads.jsonl   (removed-check leads)
                                             diff-manifest.json (staleness keys)
```

The diff is computed **once**, materialised, then queried many times (spec 10
§3.3's rule: materialise what gets diffed/re-read; compute live what is a
cheap set operation — surface deltas are set-diffs over the two indexes and
are served live).

## 1. Inputs, identity, staleness

- Inputs: two artifact directories, `--old` and `--new`, each valid per spec
  10 (manifest present, hashes verified via `ArtifactService` construction —
  a stale artifact is `E_STALE_INDEX` before any diffing starts).
- **Same-app precondition is asserted, not assumed silently**: the tool
  refuses (exit non-zero, `E_DIFFERENT_APP?`) unless `--force-pair` is given,
  when the module-match rate (§3 pass 1) falls below 20% — diffing two
  unrelated apps produces confident-looking garbage, the exact untruth this
  stage forbids. The refusal message states the measured rate.
- `pairId` = `<first 12 hex of old bundle sha256>__<first 12 of new>`.
  `diff-manifest.json` records both bundles' `sha256`, both `index.semanticHash`
  values, both producers, both `hbcVersion`s, the diff schema version, and the
  matcher's parameter table (§3.4 weights/thresholds) verbatim.
- **Staleness is an error, never a wrong answer** (spec 10 §4.2 inherited):
  every `diff` verb re-checks `diff-manifest.json` against both artifacts'
  current manifests; any mismatch = `E_STALE_DIFF`, exit non-zero, no output,
  fix = `hbc2js diff build` again. No `--force`.
- **Cross-hbcVersion honesty**: if the two bundles' `hbcVersion` differs (RN
  upgrade between app versions), every summary and every `diff functions`
  answer carries a one-line banner
  `! cross-version 94→96: compiler output differs; exact-tier rate will be lower, structural features are the primary signal`.
  Nothing else changes — the normalisation in §2 is version-neutral by
  construction, so equality remains equality; the banner manages expectations,
  it does not relax any truth rule.

## 2. `fnsig.jsonl` — the additive artifact file this spec adds (spec-10 amendment)

One row per function, built by the index builder alongside `functions.jsonl`,
part of the **semantic layer** (render-independent, covered by
`index.semanticHash`, checked by `check-index.ts`, counted against spec 10 §5
target 3's existing budgets — build ≤ 25% of decompile time, `index/` ≤ 70% of
rendered bytes; this file is a few dozen bytes/fn and must not renegotiate
either number):

```json
{"fn":42,"bodyHash":"<sha256/16B hex>","opcSeqHash":"<sha256/16B hex>",
 "opc":{"call":3,"jcond":5,"throw":1,"new":0,"ret":2,"total":57},
 "guards":5,"strs":4,"lits":"<sha256/8B of sorted literal-string-value hashes>"}
```

- **`bodyHash`** — the exact-match key. sha256 over the function's instruction
  stream, normalised so that everything that renumbers between builds is
  replaced by what it *means*:
  - opcode → its **name** (names are stable across the version tables; the
    per-version tables come from the MIT `BytecodeList.def` derivation we
    already ship — never hermes-dec),
  - string-table operand → sha256/8B of the string **value** (stable when the
    string is; sids are not),
  - function-table operand (CreateClosure targets etc.) → the fixed token `F`
    (child identity is resolved by the matcher, not baked into the hash —
    baking it in would make every leaf change cascade to every ancestor),
  - jump target → signed **instruction-ordinal delta** (byte offsets shift
    with operand-width re-encoding; ordinals don't),
  - register operands, immediates, builtin **names**: as-is.
  Two functions with equal `bodyHash` execute the same instruction stream over
  the same strings — that is a fact, not a heuristic, which is why exact-tier
  matches may be asserted as matches.
- **`opcSeqHash`** — sha256 over the opcode-name sequence with ALL operands
  dropped. Survives string edits and literal tweaks; the strong-tier workhorse.
- **`opc`** — a small fixed-class histogram (calls, conditional branches,
  throws, constructions, returns, total instruction count). The class→opcode
  mapping is a per-version data table in-repo, derived from the opcode tables,
  pinned by a test (same governance as spec 10 §2.5's host-global list).
- **`guards`** — the count of **conditional-branch instructions** (the `jcond`
  classes: JmpTrue/JmpFalse/JEqual/JStrictEqual/JLess… families per version
  table). This is the removed-check signal (§4.3) and is deliberately defined
  at the bytecode level so it is *detectable and recountable*, not an AST
  opinion. The §4.1-style checker recount covers it.
- **`strs`** — count of distinct string values used (the per-value sets come
  live from `string-uses.jsonl` ⋈ `strings.json`; only the count is
  materialised here). **`lits`** — order-independent hash of that value set,
  a cheap equality probe before the live Jaccard.

Everything else the matcher consumes already exists in the artifact:
per-fn string-value sets (`string-uses.jsonl` + `strings.json`), global sets
(`globals.jsonl`), callee profiles (`calls.jsonl` — resolved `g:`/`b:` names
and edge-kind counts; `?` edges count as `?`, never invented), module
ownership and deps (`modules.json`), params/parent/bytecode name
(`functions.jsonl`).

## 3. The matching algorithm — defined honestly

Matching is per-function, one-to-one, tiered. **A tier is a statement about
evidence, not about hope.** The output never contains a pair asserted above
the evidence for it.

### 3.1 Pass 0 — module anchoring

Match modules first (it shrinks every later candidate set from O(bundle) to
O(module)):

1. deps-identified modules (spec 08/`src/deps` evidence recorded in the
   artifact's module rows): equal package/path ⇒ module match, tier `exact`.
2. remaining: factory-fn `bodyHash` equality, unique both sides ⇒ `exact`.
3. remaining: greedy best-score on the module's own fn-multiset signature
   (multiset of member `bodyHash`es — Jaccard), threshold ≥ 0.5 ⇒ `candidate`
   module match.
Unmatched modules are reported as added/removed modules (`diff modules`).

### 3.2 Passes 1–3 — function tiers

Within each matched-module pair (then one global leftover pass for functions
that moved modules, allowed to use **exact only**):

- **Tier `exact-hash`** — `bodyHash` equal AND unique on both sides of the
  scope. If a hash has multiple holders on either side (duplicated helpers —
  common), the pairing between holders is decided by context (parent match,
  bytecode name, module) when that decides it *uniquely*; otherwise those
  holders drop to `candidate` **even though the hash matched** — a hash match
  with an ambiguous assignment is not an identity claim about any one pair.
- **Tier `strong-structural`** — not exact, but the similarity score (§3.4)
  ≥ **0.90**, the best candidate wins by a margin ≥ **0.15** over the
  runner-up, and at least **two independent anchor families** agree (families:
  opcode {`opcSeqHash`/`opc`-cosine}, strings {`lits`/Jaccard}, identity
  {bytecode name, parent-match}, environment {globals, callee profile}). This
  is the "same function, edited" tier — changed functions live here.
- **Tier `candidate`** — best score ≥ **0.60** without the strong-tier
  uniqueness/margin/anchors. Rendered ONLY in candidate language
  (`fn:42 ≈? fn:57 score 0.71`), never counted in "changed" totals, never
  eligible for auto-rebind, never presented without its score.
- **`unmatched`** — everything else. Old-side unmatched = *removed*;
  new-side unmatched = *added*. An honest `unmatched` is a first-class answer,
  exactly like spec 10's `?` callee.

A pair is **changed** iff matched at `exact-hash`… — impossible by definition
— so: **changed = matched at `strong-structural` with unequal `bodyHash`**,
plus the rare exact-tier pair whose *live* features differ (string set drifted
via a >4KB head collision — the checker treats that as a bug, not a category).
`exact-hash` pairs are *unchanged* by construction.

### 3.3 Determinism

Same two artifacts + same matcher parameters ⇒ byte-identical `match.jsonl`
(sorted by old `fn`, ties impossible one-to-one). Greedy assignment iterates
in sorted-score-then-fn order; no RNG anywhere. Asserted by T8.

### 3.4 The score

Fixed weighted sum in [0,1], weights and thresholds a **data table in the
diff-manifest** (so a report is reproducible even after retuning):
`opcSeqHash` equal 0.30; `opc` cosine 0.15; string-value Jaccard 0.20;
global-set Jaccard 0.10; callee-profile Jaccard 0.10; params equal 0.05;
bytecode name equal (non-null both sides) 0.05; parent matched at ≥ strong
0.05. Tuning happens ONLY on app-gen pairs (§6); thresholds 0.90/0.15/0.60
are the spec's opening values and any retune is a reviewed data-table commit
with the §6 quadruple re-measured, never a silent constant edit.

### 3.5 `match.jsonl`

```json
{"old":42,"new":57,"tier":"exact-hash","changed":false}
{"old":43,"new":58,"tier":"strong-structural","score":0.94,"anchors":["opc","strings"],"changed":true}
{"old":44,"new":null,"tier":"unmatched"}
{"old":45,"new":61,"tier":"candidate","score":0.71}
```

## 4. The delta views

### 4.1 Functions (`diff functions`, `diff fn`)

Added / removed / changed lists straight off `match.jsonl`, with each row
carrying id, tier, score where applicable, module, name-if-any, and — for
changed rows — the one-line feature delta (`guards 5→3 strs +2 opc.call +1`).
Source-level inspection is NOT re-implemented: the analyst runs the existing
`hbc2js query source --artifact <old|new>` on each side (spec 10's only
source-emitting verb stays the only one).

### 4.2 Surface (`diff strings`, `diff native`, `diff globals`, `diff modules`)

Live set-diffs over the two artifacts' indexes, keyed by **value**, never by
sid/fnIndex:

- strings: added/removed string **values** (heads for >4KB rows, marked, per
  spec 10 §2.3), each with its use-count and using-fns (new ids on the added
  side, old ids on the removed side). `--class endpoint|secret|<cat>` filters
  through the spec-12 classifier (`url`/`path-fragment` ⇒ endpoint; the
  secrets tiers likewise) — "what endpoints appeared in v1.2.4" is this verb
  with one flag, reusing spec 12's patterns, not re-deriving them.
- native: added/removed `(surface,name)` rows from the two `native.jsonl`s;
  `host-global?` candidates stay marked as candidates through the diff.
- globals: added/removed global names with access kinds.
- modules: added/removed/moved modules from pass 0.

### 4.3 Removed checks (`diff checks`) — leads, defined detectably

A **removed-check lead** is: a matched pair with `tier ∈ {exact… }` — exact
can't lose a guard — so: `tier = strong-structural`, `changed = true`, and
`guards(new) < guards(old)`. That is the whole definition, and it is
recountable from the two `fnsig.jsonl`s by the checker. Ranking (for the
bounded answer): larger guard deficit first, then higher tier/score, then
functions whose *removed-side* guard context touched security-interesting
surface — computed live as: globals/strings present in old-fn but absent in
new-fn that are host-globals (spec 10 list) or spec-12 endpoint/secret-tagged
values; those names are printed on the row as *why it ranks*, e.g.
`fn:43→58 guards 5→3 score .94 lost-context: g:XMLHttpRequest "https://api…"`.

Honesty rules: every row is labelled `lead`; the verb's header says
`leads = guard-count drops in matched changed functions; verify by reading both sides`;
a candidate-tier pair NEVER produces a lead (a lead on a guessed match would
be a guess wearing a siren). No auto-written findings in v1 — `--write-findings`
is reserved (§8); the analyst/LLM writes the finding after looking, with the
diff row as evidence.

### 4.4 Annotation re-binding (`diff orphans`, `diff rebind`)

Spec 11 §2.5 built the input: on the new artifact, every old-version
annotation whose target no longer resolves is `orphaned`, live-computed, with
its write-time `ctx` snapshot (name / file:line / owning-fn signature). This
spec owns re-attachment:

- Each orphan's target is mapped through `match.jsonl` (fn-level targets map
  directly; `{fn,reg}`/`{fn,env}` binding ids map iff the fn maps AND the reg/
  env slot exists in the new function — slot existence is checked against the
  new artifact, and for `strong-structural` pairs a surviving reg *number* is
  NOT assumed to be the same variable, see tier rule below).
- **Tier rule (spec 11's orphan discipline, binding): auto-rebind at
  `exact-hash` ONLY.** Same instruction stream ⇒ same register/env layout ⇒
  reg/env sub-ids carry over mechanically. `strong-structural` and below —
  including reg-level ids on strong fn pairs — are **FLAGGED**: emitted by
  `diff orphans` as proposals (`orphan rid:17 "authCheck" → fn:58? tier strong .94 — confirm: hbc2js project rebind 17 fn:58`),
  never applied. A wrong auto-rebind silently attaches a finding to the wrong
  code — spec 11 §2.3's "worse than orphaning" failure — so the bar is
  identity, not similarity.
- Applying: `diff rebind --apply-exact` (and the per-record
  `project rebind <rid> <target>` for confirmed proposals, a small P2.2
  ProjectService addition this spec's step 6 delivers) appends a NEW record —
  same kind/type fields, new target, fresh `ctx` snapshot, provenance
  `{source:"tool", who:"version-diff", run:<pairId>}` (or the confirming
  human/LLM for manual rebinds), plus `rebindOf:<old rid>`. The old record is
  untouched (append-only holds); it simply stops being orphaned-and-unheard.
  Zero-silent-drop: `#orphans_before = #rebound + #flagged + #still-orphaned`,
  printed by `diff rebind` and asserted by T6.

## 5. CLI + service surface, and TOKEN COST OF USE (hard bounds)

`hbc2js diff <verb> --old <dir> --new <dir>` (build once; other verbs read the
materialised pair), listed in `--help`; a resident `DiffService` mirrors the
verbs for the loop (constructor takes the two warm `ArtifactService`s + the
`ProjectService`; every method returns the already-bounded rows). Spec 10 §3.1
output contract restated: ids + one-line facts; truncation SAYS so
(`… 61 more; use --all/--page`); never source.

| verb | answer shape | bound (default) |
|---|---|---|
| `diff build` | one confirmation block: pairId, match counts per tier, banner(s) | ≤ 12 lines |
| `diff summary` | added/removed/changed fns per tier; surface delta counts; lead count; orphan counts | ≤ 20 lines |
| `diff functions [--added\|--removed\|--changed\|--tier t]` | one line per row (§4.1) | ≤ 50 lines + total |
| `diff fn <oldFn>` | the one match: tier, score, anchor evidence, feature deltas, runner-up if candidate | ≤ 20 lines |
| `diff strings [--added\|--removed] [--class c]` | value-head + counts + fns per row | ≤ 50 lines + total |
| `diff native` / `diff globals` | added/removed surface rows | ≤ 30 lines + total |
| `diff modules` | added/removed/moved module rows | ≤ 40 lines + total |
| `diff checks` | ranked lead rows (§4.3) with the header disclaimer | ≤ 40 lines + total |
| `diff orphans` | rebind proposals + still-orphaned rows | ≤ 50 lines + total |
| `diff rebind --apply-exact` | the zero-silent-drop accounting line + per-record lines | ≤ 30 lines + total |

## 6. Decision-8 quadruple (metric / target / method / held-out)

Ground truth comes from the app-gen fuzzer (spec 09 §2): **two builds of the
SAME generated app with a seeded modification**. Fixture flow, specified here
and delivered as §9 step 7 in `tools/appgen/` (coordinate: appgen is another
lane's tree; this step lands as a small additive mutation mode):

- `generate.mjs --seed S` produces app A; `generate.mjs --seed S --mutate M`
  replays the same PRNG stream and then applies a seeded mutation plan drawn
  from a catalogue: `edit-fn-body` (change a screen handler's logic),
  `remove-guard` (delete one `if (…) return/throw` wrapper), `add-endpoint`
  (new fetch to a generated URL), `add-fn`, `remove-fn`, `rename-file-move`
  (move a fn between modules). The plan is written to the pair's
  `mutations.json`: for every source function, its file/name/span and whether
  it is `same|edited|added|removed|moved`, plus per-mutation detail (which
  guard, which URL).
- Both sources build through the existing no-Gradle pipeline (spec 09 §2.2)
  into a **pair** of triples; the pair's TRUE fn-map is derived by keying both
  sides' functions through their source maps to `(source file, original
  name/position)` — perfect ground truth, no human labelling. Pairs live under
  `$HBC2JS_APPGEN_DIR/pairs/<id>/` inside spec 09 §2.4's existing disk
  envelope (a pair = 2 triples; the 24-triple cap counts them).

| # | metric | target | measured how |
|---|---|---|---|
| 1 | **Asserted-match truth**: on ≥ 5 seeded pairs, a match asserted at `exact-hash` or `strong-structural` whose true mapping (source-map key) disagrees | **0 wrong asserted matches** (the diff's whole value is that asserted tiers can be trusted); `candidate` accuracy and unmatched-rate are *reported*, not targeted. Secondary: ≥ 90% of truly-unchanged functions land at `exact-hash`; ≥ 80% of seeded `edited` functions matched at `strong-structural` | `tools/diff/measure.ts --pairs` joins `match.jsonl` against each pair's source-map truth; numbers in the landing report |
| 2 | **Removed-check leads**: seeded `remove-guard` mutations (≥ 10 across the pairs) surfaced by `diff checks` | **recall 100%** (every seeded removal appears as a lead — a missed removed check is the silent-vuln miss this tool exists for); lead volume is *reported* (median leads/pair) with a soft ceiling of 40/pair before ranking quality is revisited — leads are recall-first by design | same `measure.ts`; each seeded removal's fn located via the truth map |
| 3 | **Token + run cost**: every verb within its §5 cap over the verb corpus (every verb × both fixture pairs); `diff summary` median ≤ 1.2 KB; `diff build` wall-time ≤ 15% of ONE artifact's semantic-index build time; `diff/<pair>/` on disk ≤ 5% of one artifact's `index/`; `fnsig.jsonl` stays inside spec 10 §5 target 3's existing budgets (re-measured, both numbers in the report) | all bounds met | `tools/diff/measure.ts`, best-of-3 for times |
| 4 | **Held-out check**: targets 1–3 hold on version pairs never used while tuning §3.4 | unchanged | tune ONLY on app-gen pairs; measure on (a) a real rn-template RN-version-bump pair (two template builds, different RN patch versions — the spec-11 E6 bump artifact flow, re-fetched not mutated) and (b) the react-navigation bundle vs a re-fetched newer build (`fetch.sh` discipline: fetch once, hash-record; if no second version is obtainable, the landing report says so and (a) alone is the held-out — stated, not fudged). Orphan/rebind zero-silent-drop (T6) asserted on (a) with a real store carried across the bump |

## 7. Acceptance tests (shipped with this spec's step 0, red before code)

`tests/diff/` (gate-fast unless marked sweep). Per docs/CONSOLIDATION.md §B:
no exact-output assertions on shared construct fixtures; T-fixtures below are
diff-private or synthetic.

- **T1 matcher (pure, synthetic `fnsig` rows + minimal index tables)**:
  (a) identical sets with shuffled fnIndex ⇒ all `exact-hash`;
  (b) duplicated helper bodies with no disambiguating context ⇒ `candidate`,
  NOT exact (the §3.2 ambiguity rule); (c) one edited fn ⇒ `strong-structural`
  + `changed:true`; (d) an added and a removed fn ⇒ `unmatched` rows, never
  force-paired; (e) score below 0.60 ⇒ unmatched; (f) margin < 0.15 ⇒
  candidate not strong; (g) determinism: two runs byte-identical (=T8).
- **T2 fnsig builder**: on one construct-fixture bundle, recompiling the SAME
  source twice yields identical `bodyHash` per fn; changing one string literal
  changes `bodyHash` but not `opcSeqHash`; the per-version `jcond` class table
  is pinned (governance test, host-global-list style).
- **T3 removed check, end-to-end on a diff-private fixture pair**:
  `tests/fixtures/diff/guard-pair/{a,b}/source.js` — b = a minus one `if`
  guard, compiled with the in-repo hermesc for one version. `diff checks`
  surfaces exactly that function as a lead; the pair's unchanged functions are
  `exact-hash`; the lead row carries `lead` labelling and the guard delta.
- **T4 caps + truncation**: every verb's output within its §5 bound on the T3
  pair inflated with synthetic rows; truncated answers contain the
  `… N more` line (assert the line, not the whole output).
- **T5 staleness**: mutate one artifact's manifest after `diff build` ⇒ every
  verb exits non-zero `E_STALE_DIFF` with no rows; unrelated-app guard: two
  different construct bundles ⇒ refuse with the module-match-rate message.
- **T6 rebind discipline**: a store with annotations on exact-, strong- and
  unmatched-tier targets carried across the T3 pair: `--apply-exact` rebinds
  exactly the exact-tier ones (append-only: old records untouched, new records
  carry `rebindOf` + tool provenance + fresh `ctx`), strong-tier emitted as
  proposals only, accounting line balances (zero silent drops); reg-level id
  on a strong pair is proposal-only even when the reg number exists.
- **T7 surface delta**: T3 pair with b also adding one URL string: `diff
  strings --added --class endpoint` shows it (by value); removed side empty;
  sid renumbering between the two bundles does not produce phantom rows.
- **T8**: (folded into T1g + a whole-pair byte-identical `match.jsonl` check.)
- **T9 (sweep, oracle-gated)**: one seeded app-gen pair through
  `measure.ts` — asserts quadruple targets 1–2 on that pair (the full ≥5-pair
  measurement is the landing report's job, not the gate's).

## 8. Non-goals (v1) and where they attach later

- **Auto-written findings from leads** (`--write-findings`): reserved until
  lead precision is measured; the P2.7 loop writes findings with diff rows as
  evidence in the meantime.
- **Instruction-level / rendered-source textual diff of a changed pair**: use
  `query source` on both sides; a proper aligned diff view can attach later as
  a `diff fn --source` extension.
- **Obfuscation-resistant matching** (identifier-independent beyond what §2's
  normalisation already gives): Stage 3 deobf's problem; the matcher will
  benefit from it for free via the artifact.
- **Cross-APP diff** (two different apps sharing libraries) and 3-way diffs:
  out of scope; the §1 same-app guard exists precisely to refuse the first.
- **Semantic equivalence proving** for changed pairs (harness-grade): the
  tiers are structural evidence, deliberately cheaper.
- **Symbol-level module export diff**: blocked on spec 10 §6's
  `symbols.jsonl`; attaches as a new verb when that exists.
- **Auto-rebind above exact**: not a v1 threshold to tune — a policy line.
  Revisiting it is a reviewed spec change, not a flag.

## 9. Implementation plan (lean-agent-sized, ordered; reuse column is binding)

| step | delivers | reuses (binding) |
|---|---|---|
| 0 | `tests/diff/` red harness: T1–T8 skeletons, T3 fixture pair built by a `build.sh` addition | construct-fixture build.sh pattern |
| 1 | `fnsig.jsonl` in the index builder + checker recount + spec-10 budgets re-measured; T2 green | `src/artifact/{build,semantic-walk,schema}.ts`, opcode tables |
| 2 | matcher core `src/diff/match.ts` (pure: sig rows in, tiered map out); T1 green | nothing from internals — pure |
| 3 | `diff build`: materialised pair dir, diff-manifest, staleness, same-app guard; T5, T8 | `ArtifactService` |
| 4 | surface deltas + `diff checks` ranking; T3, T7 | spec-12 classifier, host-global list |
| 5 | CLI verbs + `DiffService` + caps + `tools/diff/measure.ts`; T4 | `src/cli.ts` query/secrets verb pattern |
| 6 | rebind: `diff orphans/rebind` + `project rebind`; T6 | `ProjectService`, spec-11 store io |
| 7 | app-gen mutation mode + pair truth extractor + quadruple measurement; T9 + landing numbers | `tools/appgen/{generate,build,compare}.mjs` (additive; coordinate with the appgen lane) |

Each step is one lean-agent task, committed with its tests; step 7's appgen
edits are additive flags only (no behaviour change to existing triples).

## 10. Open questions for the reviewer

1. **Strong-tier reg-level rebind**: §4.4 flags reg-level ids even on strong
   pairs. Is there appetite for a narrower carve-out (reg carries over when
   `opcSeqHash` is equal — same instruction skeleton — even though `bodyHash`
   differs on string operands only)? It is defensible identity-wise but adds
   a third rebind class; v1 says no.
2. **Thresholds** 0.90/0.15/0.60 and the §3.4 weights are opening values with
   the retune-is-a-reviewed-data-commit rule; confirm that rule suffices vs
   freezing them until the quadruple exists.
3. **Diff dir placement** inside the NEW artifact (`<new>/diff/<pairId>/`):
   keeps the analyst's working artifact self-contained but writes into a spec-10
   directory; alternative is a sibling `diffs/` root. Spec says inside-new.
4. **Lead volume ceiling** (target 2's soft 40/pair): reported-not-targeted is
   the recall-first stance; confirm, or set a hard precision floor now.
5. **Held-out (b)**: if no second react-navigation build is obtainable under
   the fetch-once discipline, is held-out (a) alone acceptable for landing?

## 11. Review responses

*(placeholder — filled by the decision-8 review gate before implementation.)*
