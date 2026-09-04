# W_AMBIGUOUS_CLOSURE_ENV — characterisation and the fix design

Date: 2026-09-05. Bundle: `tests/fixtures/bundles/react-navigation-example-0.85.3/react-navigation-example.hbc`
(15,551 functions), `strictEnv: false`, measured on macOS / node 25 with
`src/decompile.ts` at commit `0fe77eb` plus the `closureCreationSites` addition
in this commit. Owner of the open half: docs/BUGS.md row of 2026-09-04, cause (a).

This report exists because the *expected* shape of the bug turned out to be
wrong, and the numbers below are the reason the cheap fix was not landed.

## 1. What is ambiguous

`src/cfg/env-graph.ts` records `closureEnvOf(f)` from every `Create*Closure` /
`Create*Class` site that makes a closure over function index `f`. When two sites
disagree the function joins `closureEnvConflict`: it is reported
`W_AMBIGUOUS_CLOSURE_ENV` and `closureEnvOf(f)` is forced to `null`, which makes
it an *orphan* for `src/emit/placement.ts`, which then hosts it wherever the
fewest names come out unbound.

Two consequences, both visible on this bundle:

* the body is emitted **once**, with `_e<env>_<slot>` names taken from whichever
  site the fixed point happened to record first (`noteClosure` keeps the first
  environment; the conflict set only overwrites `closureEnvOf` *after* the
  access-collection round, so every access resolved against site 0's chain);
* the `_fn<n>` reference at every *other* site is emitted in a function that
  does not contain the host, so it is unbound.

178 functions are ambiguous here; 103 functions are isolated with
`W_UNBOUND_ISOLATED` and 158 names are unbound, and cause (a) owns all of them
(cause (b) is fixed and moved neither number).

## 2. Bucket table (all 178)

Creation sites per ambiguous function:

| sites | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 14 | 30 |
|---|---|---|---|---|---|---|---|---|---|---|
| functions | 109 | 25 | 23 | 7 | 6 | 3 | 1 | 2 | 1 | 1 |

Every site of every one of the 178 captures a *distinct* environment node — there
is no case of N sites sharing M<N environments.

Structure of the disagreement. "Aligned" = every site's environment chain has the
same length and is node-for-node identical **above the leaf**, so only the
directly captured environment differs. "Touches leaf" = the function's own body
loads from or stores to a slot of that differing leaf.

| # | creating functions | env chains | body touches the leaf | count |
|---|---|---|---|---|
| A | more than one | aligned, same shape | yes | 129 |
| B | exactly one | aligned, same shape | yes | 23 |
| C | more than one | different length/shape | yes | 15 |
| D | more than one | aligned, same shape | no | 6 |
| E | more than one | different length/shape | no | 3 |
| F | exactly one | aligned, same shape | no | 2 |

Totals: **160 of 178 differ only in the leaf environment**, 18 have chains of
different length. 25 have all their sites inside a single creating function
(Hermes inlined a closure-making helper several times into one caller); the other
153 are created from two or more *different* functions, which on this bundle are
near-identical Metro module factories — Hermes deduplicated one function body
across two copies of the same module, so the same function index is nested in two
different lexical parents. All 178 read only environments that lie on their own
captured chain (no function reads an environment reached by any other route).

Sample, function #10156: sites `10155:…` and `10157:…` capture envs 72 and 73,
both of shape `size 2, no parent`, and the body reads slots 0 and 1 — of env 72,
because that is the site the fixed point saw first. On the other site those two
reads are the wrong variables.

## 3. The hypothesis that failed

The expectation going in was that most of the 178 are the inlined-helper case
where "the body would emit identically under either environment", so no
duplication is needed: pick one, stop reporting it. That is buckets D+F+E = **11
of 178** by the body's own accesses, and only **4 of 178** once the test is made
sound by including the function's whole lexical subtree (a nested closure reading
through the differing environment is just as wrong as the body doing it) and by
requiring both chains to be resolved down to a known root. The other 156 read the
differing environment directly: they need a per-context body, not a choice.

That rule was implemented and measured (`namesAgreeAcrossSites`: equal chain
lengths, chains fully resolved to a `null` parent, and no function in the lexical
subtree accessing any environment the sites disagree about) and then **reverted**:

| | ambiguous | isolated | unbound names | orphans hosted | bytes |
|---|---|---|---|---|---|
| today | 178 | 103 | 158 | 111 | 16,332,173 |
| with the structural join | 174 | 106 | 161 | 109 | 16,325,659 |

Joining the 4 makes them non-orphans, so `src/emit/placement.ts` stops choosing
their host by cost and the emitter puts them in their lexical home — which for 3
names is a place those names are not visible. The trade is arguably the right one
(an honest unbound name in the lexically correct place, instead of a
wrong-but-bound name in a place picked to make the count look good), but it moves
the sweep ratchet the wrong way for a class of 4, so it is recorded here rather
than landed. It should land together with §4, which removes the reason placement
has to guess at all.

## 4. Design: per-creation-context bodies

The only correct fix for buckets A, B and C is to stop emitting one body for a
function that has more than one lexical identity.

**Rule.** A function `f` whose `closureCreationSites` hold more than one distinct
environment is emitted **once per distinct environment**, not once. Copy `i` is
named `_fn<f>__c<i>`, is placed in the owner function of the environment captured
at that site (the same rule an unambiguous function already follows), and every
`Create*Closure` site that captured that environment emits `_fn<f>__c<i>`. No
site is ever left referring to a copy it cannot see, so `resolveOrphanHosts` has
nothing to place and the `_fn<n>` half of the unbound names (58 today) goes to
zero by construction.

**Naming inside a copy.** Copy `i` must resolve its env-slot names against site
`i`'s chain. For the 160 aligned cases this is a pure substitution: the chains are
node-for-node identical above the leaf, so copy `i` is copy 0's body with
`leaf₀ → leafᵢ`, i.e. a `ReadonlyMap<EnvNodeId, EnvNodeId>` applied wherever
`src/emit/names.ts`'s `envSlot(env, slot)` is called, plus the same remap on the
environments the copy's own subtree creates (their `parent` is the leaf). For the
18 unaligned cases the remap is positional over the whole chain and is only
defined when the chains have equal length; when they do not, that function stays
`W_AMBIGUOUS_CLOSURE_ENV` and keeps today's behaviour.

**Where the work is.**
1. `src/cfg/env-graph.ts` — already exports `closureCreationSites` (this commit).
   Add, per ambiguous function, the per-site env remap and the transitive set of
   nested functions that travel with each copy (`lexicalSubtree`, drafted in §3).
2. `src/emit/index.ts` — the function-placement map becomes `fn -> list of
   (copy id, host)` instead of `fn -> host`; `src/emit/placement.ts` keeps its
   cost rule only for functions with *no* resolved site at all.
3. `src/emit/function.ts` / `names.ts` — thread an optional
   `envRemap: ReadonlyMap<EnvNodeId, EnvNodeId>` through body emission; every
   `envSlot()` call site goes through it. This is the one invasive edit.
4. `src/emit/scope-check.ts` — a copy's names must be checked in its own host.
5. Spec: docs/specs/03-cfg.md §6.2 (the conflict is data, not a dead end) and
   docs/specs/05-emitter.md §6 "Function nesting" (one body per creation context).

**Cost of not doing it.** 178 functions on this bundle emit env-slot names that
are correct for one creation site and silently wrong for the others. That is a
*semantic* defect, not a cosmetic one, and it is not visible in the unbound count
— the 103/158 only count the names that fail to resolve.

**Test plan.** No small `source.js` reproduces this (probed: identical inner
bodies, a twice-called helper, a generator over a loop variable — none produce a
deduplicated function index under hermesc v96/v99), so the regression tests are
(a) synthetic modules built on `buildEnvGraph` the way
`tests/gate/cfg/env-no-capture.test.ts` does, one per bucket A/B/C, asserting the
per-site remap, and (b) the react-navigation ratchets in
`tests/sweep/emit/unbound-env-slots.test.ts`, which should go to 0 isolated /
0 unbound for the aligned buckets (expected residual: the 18 unaligned).


## 5. What landing §4 actually did, and what is left

Landed 2026-09-05 (`cfg: one creation context per environment…` +
`emit: one body per creation context…`). Measured on the same bundle, same
options (`strictEnv: false`), on macOS / node 25. The `.hbc` was rebuilt locally
with `tools/hermesc/v98` from the committed `index.android.bundle`; it is 7
bytes smaller than the artefact `BUILD.md` records, so the byte totals below are
comparable to each other but not to §3's table.

| | ambiguous | duplicated fns | extra bodies | isolated | unbound names | orphans hosted | W_ORPHAN_FUNCTION |
|---|---|---|---|---|---|---|---|
| before | 178 | 0 | 0 | 103 | 158 | 111 | 0 |
| after | 18 | 156 | 335 | 79 | 155 | 13 | 0 |

The split of the 178 is exactly the one §2 predicted: **156** get per-creation-context
bodies, **4** are joined by §3's `namesAgreeAcrossSites` rule (which lands here,
where it is correct), and **18** — the unaligned chains — keep today's
behaviour. `--passes=none` gives the same 79 / 155. Bytes 16,332,150 ->
17,728,320 with passes on (the 335 extra bodies). A bundle with no ambiguity at
all is byte-identical before and after: `rn-template-0.72/index.android.hbc`
(4,199 functions, 0 ambiguous) decompiles to the same 6,649,289 bytes.

§4 predicted 0 isolated / 0 unbound for the aligned buckets. It is 79 / 155, and
the reason is a second level of the same defect, one step down the tree:

* **123 of the 155 are `_fn<n>`**, and 29 are `_e<env>_<slot>`. The shape is
  `_fn10156__c1` referencing `_fn13573`, or `_fn10396__c1` reading `_e2192_0`.
  Both are functions/environments that belong to the duplicated function's
  *lexical subtree* by creation but not by `closureEnvOf`: a child created
  inside `f` over an environment `f` itself captured has `closureEnvOf` pointing
  at an ancestor's environment, so `parentOf` puts it beside copy 0 and no other
  copy can see it. §4's "nested functions travel with their copy" covers this
  case in words; the implementation only moves the `closureEnvOf`-children.
* The obvious fix — reparent every function whose creation sites all lie inside
  the subtree under the duplicated root — was implemented and **measured worse**
  (79 -> 86 isolated, 155 -> 166 unbound), because moving such a function
  *inwards* takes it out of scope of the other, non-duplicated sites that also
  see it today. It is reverted; the numbers are recorded here so the next
  attempt does not repeat it. The right version has to reparent per copy (a
  child that travels gets one instance per copy, like the root does) rather than
  once for the whole function, and that needs `parentOf` to become
  per-instance — the same generalisation the emitter already makes for
  `emitOne`'s `CopyCtx`.

Remaining work, in order:

1. Per-copy travel for creation-site-only children (the 123 `_fn` names above):
   make the child's placement a property of the *instance* being emitted, not of
   the function index. Expect it to subsume the 29 `_e` names too, since those
   are the same functions reading through the same chain.
2. The 18 unaligned residual: chains of different length have no positional
   remap. They need either a chain-alignment by *owner function* rather than by
   position, or an explicit decision to leave them as `W_AMBIGUOUS_CLOSURE_ENV`
   forever, recorded in `docs/DECISIONS.md`.
3. A self-recursive closure that creates itself over an environment it owns
   hosts its own copies (9 on this bundle). They are emitted as siblings inside
   the copy-0 instance, which is in scope for all of them; if a case ever
   appears where copy 0 is not emitted, those copies are lost. There is no
   test for that path because no input produces it.
