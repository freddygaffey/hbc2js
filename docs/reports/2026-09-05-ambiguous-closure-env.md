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

### Landing item 1: per-instance placement (2026-09-05, later)

Two defects, one shape. Measured on the same bundle and options, macOS / node 25:

| | isolated | unbound names | `_fn<n>` | `_fn<n>__c<i>` | `_e<env>_<slot>` | bytes |
|---|---|---|---|---|---|---|
| §5 landing above | 79 | 155 | 112 | 35 | 8 | 17,728,320 |
| + per-copy travel | 69 | 131 | 88 | 35 | 8 | 17,809,223 |
| + `emitName` fix | **32** | **63** | 20 | 35 | 8 | 17,923,967 |

1. **Per-copy travel.** Placement is now a property of the *instance*: while
   emitting a copy of `f` (or anything nested inside it), every closure the body
   creates whose `closureEnvOf` home is not already inside that instance gets
   its own instance there, under the instance's remap and under the name the
   creation site emits. Copy 0 is untouched, which is what the reverted
   "reparent the function index inward" attempt got wrong — the same child is
   usually created from non-duplicated sites too, and those keep the copy-0
   instance where it is. The creating-function → sites map is
   `closureCreationSites` inverted; a child is skipped when its home is already
   in the instance's subtree, when it is an ancestor of the instance (emitting it
   would re-emit this very body), or when its home is module level (visible from
   everywhere anyway).
2. **A copy's `emitName` was inherited by its children.** `emitOne(child, ctx)`
   passed the copy's `CopyCtx` unchanged, so every child of `_fn<f>__c<i>` was
   *itself* emitted as `function _fn<f>__c<i>()`. That both shadowed the copy
   inside its own body and left every reference to the child unbound — 68 of the
   155 names. `name` now applies to the instance only (`childCtx`), with the one
   thing it was read for downstream carried by an explicit `inCopy` flag.

Control: a bundle with no ambiguity is byte-identical before and after
(`rn-template-0.72/index.android.hbc`, 0 ambiguous — 5,000,434 bytes at CLI
defaults, `cmp`-identical against the same tree with only `src/emit/index.ts`
reverted). It cannot be otherwise: with `closureCopies` empty no instance ever
has a non-empty `CopyCtx.path`, so neither new path runs. (The 6,649,289 above
was measured under a different option set and was not reproduced here.)

Sweep ratchets moved down: `MAX_ISOLATED` 79 -> 32 and a new `MAX_UNBOUND_NAMES`
63 in `tests/sweep/emit/unbound-env-slots.test.ts`. No other floor moved.

The 63 that remain are three families, none of them item 1:

* **35 `_fn<n>__c<i>`** — *mutually recursive copies*. `_fn12406__c4` references
  `_fn12407__c4` and `_fn12407__c5`, and vice versa: two functions that create
  each other, each with 5 copies, hosted in different places, so a copy can see
  its own siblings but not the other function's. §5 item 3's self-recursive rule
  covers `f` creating `f`; the mutual case needs the copies of a *recursion
  group* to be hosted together. Cheapest next fix.
* **20 `_fn<n>`** — the pre-existing orphan-placement family (`_fn13838`…
  `_fn13844` inside `_fn525 > _fn5569`, `_fn13914`…`_fn14002`): functions with no
  resolved creation environment at all, hosted by `src/emit/placement.ts`'s cost
  rule where the referencing site cannot see them. Unrelated to duplication.
* **8 `_e2192_0`** — two copies (`_fn10396__c1`, `_fn10397__c1`) reading an
  environment that is not on their captured chain, so no positional remap
  touches it.

Remaining work, in order:

1. ~~Per-copy travel for creation-site-only children~~ — **done**, above. It did
   not subsume the `_e` names: those 8 are a separate shape (an environment off
   the captured chain), and the mutually recursive copies are now the largest
   family.
2. The 18 unaligned residual: chains of different length have no positional
   remap. They need either a chain-alignment by *owner function* rather than by
   position, or an explicit decision to leave them as `W_AMBIGUOUS_CLOSURE_ENV`
   forever, recorded in `docs/DECISIONS.md`.
3. A self-recursive closure that creates itself over an environment it owns
   hosts its own copies (9 on this bundle). They are emitted as siblings inside
   the copy-0 instance, which is in scope for all of them; if a case ever
   appears where copy 0 is not emitted, those copies are lost. There is no
   test for that path because no input produces it.

### Landing item 2: recursion groups (2026-09-05, later still)

Item 1's largest residual family, the 35 `_fn<n>__c<i>`, is one shape — and it
is not only the mutually recursive pair. Measured on the same bundle and options
(`strictEnv: false`), macOS / node 25:

| | isolated | unbound names | `_fn<n>` | `_fn<n>__c<i>` | `_e<env>_<slot>` | bytes |
|---|---|---|---|---|---|---|
| item 1 above | 32 | 63 | 20 | 35 | 8 | 17,923,866 |
| + recursion groups | **16** | **28** | 20 | **0** | 8 | 20,240,933 |

(Item 1's table records 17,923,967 for the same tree; the 101-byte difference is
another agent's `src/runtime/helpers.ts` edit in the shared working tree, not
this change. The control below is what rules out a byte effect from this one.)

**The shape.** A duplicated function's copies are hosted in the owner of the
environment each captured. When that owner is the duplicated function *itself*,
or another duplicated function that creates it, the host has many instances and
the copy was emitted inside only one of them:

```
fn 12406  copy 0 env 2973 @ fn 8486    copy 1..3 env 2975..2977 @ fn 8492
          copy 4 env 4090 @ fn 12406   copy 5 env 4091 @ fn 12407
fn 12407  the same six environments, the same six hosts
```

`_fn12406`'s body creates `_fn12406`, `_fn12407` and `_fn12408` over an
environment it makes itself (env 4090) — and, critically, makes it with its
*grandparent* as the parent (`GetEnvironment r, 1`), not with the environment it
captured, which is the only reason all six chains have the same length and the
copies exist at all. So copies 4 and 5 of both functions are hosted *inside the
group*, and all the other instances (`_fn12406__c1`, `_fn12407__c4`, …)
reference a copy sitting in a body they cannot see. The same shape with a single
function is `_fn13523` (copy 3 hosted in fn#13523), `_fn15373` (copy 2),
`_fn13078` (copy 3) and `_fn11751` (copies 2 and 3): §5 item 3's self-recursion
rule was meant to cover those, but it fired only for the copy-0 instance and
only when that instance was not itself inside some other copy, so on this bundle
it fired for none of them.

**The rule.** `src/emit/index.ts` computes the **recursion groups**: Tarjan's
SCCs over the "creates" relation (`closureCreationSites` inverted by creating
function) restricted to duplicated functions, a self-loop making a group of one.
A copy whose host is a member of its own group is emitted inside **every
instance** of that host, under that instance's composed remap, instead of once
beside copy 0. What makes that terminate is the `hosted` set threaded down
`CopyCtx`: the group-copy names an enclosing instance already hoisted, plus the
instance's own name. A copy is skipped when its name is already in that set, so
the copy that would nest inside itself finds its own function declaration
instead — the correct binding, since the site that would create it there is the
self-reference. Depth is bounded by the group's copy count (3 levels for
12406/12407). The same set seeds the per-copy travel loop's `travelled`, which
had been emitting a second, identical declaration of a copy already hoisted at
the same level.

Copy 0 and every non-duplicated function are untouched. Control: a bundle with
no ambiguity at all, `rn-template-0.72/index.android.hbc` (4,199 functions,
0 ambiguous), is **`cmp`-identical**, 5,000,434 bytes at CLI defaults, against
the same tree with only `src/emit/index.ts` reverted — measured in a detached
worktree at `83f1863` so the other agents' uncommitted edits sit on both sides.
With `closureCopies` empty, `extraCopies` is empty, so no group is ever formed
and no instance carries a `hosted` set.

Sweep ratchets moved down: `MAX_ISOLATED` 32 -> 16 and `MAX_UNBOUND_NAMES`
63 -> 28. No other floor moved. Bytes grow 13% because a group's inner copies
are now emitted once per instance of their host; that is the cost of giving
every instance the bodies it references.

Regression test: `tests/support/synth-module.ts`'s `mutualRecursionFunctions`
(fn#3 and fn#4 create each other *and* themselves over an environment made under
the grandparent — 12406/12407 in miniature) plus the emit test named for it in
`tests/gate/emit/closure-copies.test.ts`. Verified RED at `83f1863` in a
detached worktree (the other group member's copy is missing from every instance
of its host, and four functions are stubbed `E_UNBOUND_IDENT`) and green after.

### Landing item 3: copies over loop-local environments (2026-09-05, later still)

Leftover 3 above — the 2 `_e2192_0` — and its diagnosis was **wrong**, in a way
worth recording. It is true that env 2192's slot 0 has one writer and no
readers; it is not true that no `let _e2192_0` is emitted. It is emitted, and it
is emitted *inside a loop body's block*:

```
L5: { … let _e2192_0; _e2192_0 = r17; r19 = _fn10396__c1; r7.get = r19; … }
```

Having one writer and no readers is exactly what makes env 2192 **loop-local**
(`src/emit/index.ts`'s `loopLocal`: created inside a cycle, no access and no
closure site outside the creating block). A loop-local environment is a fresh
record per iteration, so its `let` goes at the `Create*Environment` and every
closure made with it is emitted as a function *expression* at its
`Create*Closure` site (`inlineFunctions`). Copy 0 of fn#10396 gets that
treatment — env 2190 is loop-local too, and `r4.get = function _fn10396() {…}`
is inline. The **copies** did not: `extraCopies` always pushed them onto
`hoisted`, i.e. a function declaration at the top of the host's body, where the
loop block's `let` is out of scope. Hence `E_UNBOUND_IDENT` on `_e2192_0`.

The fix is one branch in `emitBody`: a copy whose captured environment is
loop-local in this host goes into `inlined` instead of `hoisted`, so the
lowering emits it at the site. It is taken only when the copy's sites are all in
this host *and* every recorded site of that function index in this host belongs
to this copy — `inlineClosure` is keyed by function index, so a mixed body would
otherwise bind one copy's site to the other copy's body. That is a silent
wrong-binding; the hoisted form's unbound name is loud, so the guard prefers it.

| | isolated | unbound names | `_fn<n>` | `_fn<n>__c<i>` | `_e2192_0` | `_e4551_*` | bytes |
|---|---|---|---|---|---|---|---|
| item 2 above | 16 | 28 | 20 | 0 | 2 | 6 | 20,240,937 |
| + inline loop-local copies | **14** | **26** | 20 | 0 | **0** | 6 | 20,241,172 |

Control: `rn-template-0.72/index.android.hbc` (0 ambiguous) is `cmp`-identical
against the same tree with only `src/emit/index.ts` reverted — **5,000,113
bytes** at CLI defaults. (Item 2 recorded 5,000,434 for the same control; the
difference is another agent's committed `src/runtime/helpers.ts` change between
the two measurements, not this one — the `cmp` is what rules this change out.)
It cannot be otherwise: with `closureCopies` empty, `extraCopies` is empty and
the new branch is never reached.

Sweep ratchets moved down: `MAX_ISOLATED` 16 -> 14, `MAX_UNBOUND_NAMES` 28 ->
26. No other floor moved, no golden regenerated.

Regression test: `tests/support/synth-module.ts`'s `loopLocalCopyFunctions`
(fn#1 and fn#2 both create fn#3; fn#2 makes its environment inside a loop —
which needed `instructions()` to grow real `jump`/`condJump` terminators so
`buildCfg` sees the back edge) plus the emit test named for it in
`tests/gate/emit/closure-copies.test.ts`. Verified RED at `9d9dcc1` in a
detached worktree (`_e2_0` is not declared in any enclosing scope, `_fn3__c1`
stubbed) and green after.

### What the 26 remaining unbound names actually are (2026-09-05, measured)

Item 3's brief asked for a diagnosis of "the 20 `_fn<n>` + 6 `_e4551_*` orphans:
is the graph wrong or is `src/emit/placement.ts`'s cost rule wrong?". Measured
on react-navigation-example-0.85.3 (`strictEnv:false`), the answer is **neither**:
19 of the 26 are the *unaligned residual* (leftover 4 below, Fred's item) seen
from the emitter side, and the other 7 are a **new, separate defect** in the env
graph. Nothing here is a placement-rule bug — the cost rule is choosing the best
home available for a function that genuinely has several incompatible ones.

`analyseModule`'s diagnostics carry exactly 18 `W_AMBIGUOUS_CLOSURE_ENV`
function indices: 12754, 13838–13844, 13914–13917, 14001, 14002, 14983–14986.
(`decompile()`'s `result.diagnostics` show 0 of them — they are cfg-level and do
not propagate; the sweep ratchet reads `analysis.diagnostics`, which is why
`MAX_STILL_AMBIGUOUS` still measures 18.)

* **19 names are those 18 functions.** `_fn13838`…`_fn13844` (7),
  `_fn13914`…`_fn13917` (4), `_fn14001`/`_fn14002` (2) are referenced from the
  creation site the cost rule did *not* host them at; the 6 `_e4551_*` are
  14984/14985/14986 emitted at module level while reading env 4551's slots,
  which fn#14983 declares. Their chains are unequal, e.g. fn#13838's two sites
  capture env 3639 (chain `[3639, 652]`) and env 4391 (chain `[4391]`), and
  fn#14983's four sites capture `[4551]`, `[4552]`, `[4553]` and
  `[4613, 3454, 2174]`. `src/cfg/env-graph.ts` refuses a positional remap for
  unequal chains (`c.length !== chain0.length` -> "stays ambiguous"), so these
  never become copies, `closureEnvOf` stays `null`, and every one of them is an
  orphan placed by cost. **That is leftover 4, verbatim** — the 18 unaligned
  chains — and it needs Fred, not a placement fix.
* **7 names are a different bug**: `_fn13056` (5 sites) and `_fn15251` /
  `_fn15275` (1 each). These are *not* in the ambiguous 18 and have no copies,
  yet `closureCreationSites` records several distinct environments for each,
  with **aligned** chains: fn#13056 has six sites capturing envs 3141
  (`[3141, 1939]`), 3142 (`[3142, 1939]`), 4511, 4512, 4595, 4596 — every chain
  length 2, identical above the leaf — and `closureEnvOf` is nonetheless the
  single value 3141. fn#15251's two sites capture `[4472, 1403]` and
  `[4621, 1403]`, again aligned, and `closureEnvOf` is 4472. So the copy
  machinery never runs (it iterates `closureEnvConflict`), the five non-chosen
  sites emit the plain `_fn13056`, and copy 0 is not in their scope. The
  contradiction is inside `src/cfg/env-graph.ts`: `closureCreationSites`
  disagrees with the `closureEnvOf` lattice about how many environments these
  functions are created with. **These three should be duplicated and are not.**
  That is the cheapest actionable next fix on this bundle (7 of 26 names) and it
  is a *graph* fix, not an emitter one; the next agent should start by finding
  why a recorded site does not reach the join for these three.

### Landing item 3 addendum: `closureNameAt` keyed by instance (not landed)

Leftover 5 asked for `closureNameAt` to be keyed by creation site *and*
instance. Working through it on `mutualRecursionFunctions` (the only shape that
exhibits it), the collapse it describes turns out not to be observable in the
copies the graph can build, for a structural reason worth recording before
anyone spends a day on it:

* A site inside instance *I* of `f` that creates a closure over an environment
  *I* owns emits `closureNameAt[site]`, the same `_fn<n>__c<i>` in every
  instance. Since "Landing item 2" emits that copy *inside every instance of its
  host*, under that instance's composed remap, the name resolves lexically to
  the copy declared in *I* — JS shadowing already does the instance keying for
  the binding.
* The composed remap is what would make the instances' bodies differ, and it
  cannot: a copy hosted inside its own recursion group captures an environment
  the host *owns* (env id fixed, not remapped), and the group only exists at all
  because every chain has the same length — which, in the react-navigation
  shape, is true precisely because the group's environments hang off the
  *grandparent* (`GetEnvironment r, 1`), not off the captured environment. So
  composing the instance's remap with the copy's leaves the copy's remap
  unchanged, and the inner instance is textually identical to the outer one.

The residue is therefore about *depth*, not naming: the `hosted` set stops the
nesting at the first repeat, so recursion levels beyond that reuse an enclosing
instance's body. Since the bodies are identical text, that is currently sound;
it stops being sound the moment a group appears whose inner copies compose to a
*different* remap. No input produces one, so there is nothing to assert on and
nothing to fix — a trace test written today would pass before and after any
change. Recorded as leftover 6 with the exact precondition to watch for, rather
than implemented speculatively.

### Landing item 4: where a *joined* function goes (2026-09-05, later still)

The 7 names above (`_fn13056` x5, `_fn15251`, `_fn15275`) were reported as a
contradiction inside `src/cfg/env-graph.ts` — "`closureCreationSites` disagrees
with the `closureEnvOf` lattice". Measured, it is not: the lattice and the site
map agree, and neither is wrong. All three functions **are** in
`closureEnvConflict`; they reach the copy builder, their chains align, and they
are then taken by the `!touches` branch — report §3's `namesAgreeAcrossSites`
join. `conflictResolved.add(f)` runs *before* that branch, so they leave the
graph non-ambiguous, with a real `closureEnvOf`, and with no `closureCopies`
entry. Measured on react-navigation-example-0.85.3 (`strictEnv:false`), exactly
four functions take that branch:

| fn | envs (chains) | env owners = creating functions | `closureEnvOf` |
|---|---|---|---|
| 11914 | `[2837]`, `[2838]` | 7872 | 2837 |
| 13056 | `[3141,1939]`, `[3142,1939]`, `[4511,1939]`, `[4512,1939]`, `[4595,1939]`, `[4596,1939]` | 9235, 9244, 14791, 14793, 15338, 15340 | 3141 |
| 15251 | `[4472,1403]`, `[4621,1403]` | 14225, 15474 | 4472 |
| 15275 | `[4490,4042,2943,1511]`, `[4622,4042,2943,1511]` | 14397, 15479 | 4490 |

So the defect is **placement, not duplication**. The join is sound about the
*body* — nothing in the subtree names an environment the sites disagree about,
so one body really is enough — but `src/emit/index.ts` then hosts that one body
in `ownerFunction(closureEnvOf)`, i.e. beside whichever site the fixed point
recorded first. fn#11914's sites are all in one function (7872), so it was
already right; fn#13056's six sites are in six different functions, and the five
that are not fn#9235 emit a `_fn13056` that fn#9235's declaration does not
reach.

The fix is one block in `src/emit/index.ts`, before orphan placement: a function
with two or more distinct creation environments and no `closureCopies` entry is
re-hosted at the **lowest common ancestor of its creating functions** (module
level if there is none), reported as `W_JOINED_REHOSTED`. That host is legal for
the body's own names for the same reason the join is legal: the only
environments the body can name are the ones every chain shares, and each shared
environment's owner is an ancestor of every site, hence of their LCA.
Deliberately *not* done: giving these three copies like a genuine conflict.
Their copies would be textually identical (that is what `!touches` means), so it
would be six bodies where one does — and it would invert the standing assertion
in `tests/gate/cfg/closure-copies.test.ts` that a joined function has no copies.

| | isolated | unbound names | `_fn13056`/`15251`/`15275` | `_e4551_*` | 18-unaligned `_fn<n>` | new `_fn<n>` | bytes |
|---|---|---|---|---|---|---|---|
| item 3 above | 14 | 26 | 7 | 6 | 13 | 0 | 20,241,172 |
| + LCA hosting | **10** | **22** | **0** | 6 | 13 | **3** | 20,247,457 |

(Bytes rise because four bodies that were throwing stubs are now real bodies.)
`MAX_STILL_AMBIGUOUS` is untouched at 18 — nothing in `src/cfg/**` changed.

The 3 new names are the *same* residue item 1 recorded and its "reparent
inwards" attempt failed on: `_fn15473`, `_fn15478`, `_fn14790` are each created
inside the re-hosted function over an environment that function itself
**captured**, so `closureEnvOf` parents them beside the old home and they do not
travel with it. Each re-hosted function therefore trades *n* unbound site
references for exactly one unbound child reference (5 -> 1 for fn#13056, 1 -> 1
for fn#15251 and fn#15275). It is a net win here and never a loss on this
bundle, but the rule is not cost-aware; leftover 7 below is to make a child
whose every creation site is inside `f` travel with `f`, which needs the
per-instance `parentOf` that item 1 already asks for.

Control: `rn-template-0.72/index.android.hbc` (0 ambiguous, no joined function)
at CLI defaults is `cmp`-identical against the same working tree with only the
`src/emit/index.ts` block removed — **5,000,113 bytes**. Regression test:
`bucketAFunctions(false)` (two sibling environments with the same parent, two
creating functions, a body that reads neither) in
`tests/gate/emit/closure-copies.test.ts`, verified RED at `0952e04` in a
detached worktree (fn#2 is stubbed, `E_UNBOUND_IDENT` on `_fn3`) and green
after. Ratchets: `MAX_ISOLATED` 14 -> 10, `MAX_UNBOUND_NAMES` 26 -> 22.

### Landing item 5: the child that stays behind (2026-09-05, later still)

Leftover 7. After item 4 re-hosts a *joined* `f` at the LCA of its creation
sites, a function `g` that `f` creates over an environment `f` merely
**captured** keeps its own `closureEnvOf` home beside `f`'s old site, so the
moved body's `_fn<g>` is unbound: `_fn14790` (in fn#13056), `_fn15473`
(fn#15251), `_fn15478` (fn#15275).

The narrow fix the leftover named — move a `g` whose creation sites are *all*
inside `f`, transitively — was implemented and **measured**, unguarded first:

| | isolated | unbound names | `_fn14790`/`15473`/`15478` | new `_e<env>_<slot>` | bytes (`--passes=none`) |
|---|---|---|---|---|---|
| item 4 (before) | 10 | **22** | 3 | 0 | 28,977,549 |
| move every such child | 10 | **23** | 0 | 4 (`_e3141_0`, `_e4472_0`, `_e4472_1`, `_e4490_0`) | 28,973,563 |
| move only where the child's reads stay visible (landed) | 10 | **22** | 3 | 0 | 28,977,549 |

So the narrow fix *does* bind all 3 names and is still a net **loss**: each of
those three children reads a slot of the environment at position 0 of its
creator's chain — env 3141 for fn#13056, 4472 for fn#15251, 4490 for fn#15275 —
which is exactly the environment the sites **disagree** about (see item 4's
table). No single home can bind such a child, so moving it only exchanges an
unbound `_fn<n>` for an unbound `_e<env>_<slot>`.

Why the join fired at all: `namesAgreeAcrossSites` (`src/cfg/env-graph.ts`)
decides "nothing in `f`'s lexical subtree names an environment the sites
disagree about" over a subtree built from `childrenOf`, which is the
`closureEnvOf` relation — the very relation that leaves these children outside
`f`'s subtree. Their reads were therefore never counted. Fixing *that* (a
creation-based subtree) would take the three functions out of the join and into
`closureCopies`, i.e. duplication, which is item 1's per-instance answer under
another name and a `src/cfg/**` change; it is deliberately not done here.

What landed in `src/emit/index.ts` is the narrow rule **with the visibility
guard**: a child whose creation sites are all inside the travelling set moves to
the lowest common ancestor of those sites only when every environment it reads
is declared at or above that new host (`envDeclaringFunction`), reported as
`W_JOINED_CHILD_MOVED`. On react-navigation that moves 0 children and the
decompiled bytes are unchanged (28,977,549 either way); it is correct for the
child that reads only shared environments, which the synthetic fixture covers.
Ratchets unchanged: `MAX_UNBOUND_NAMES` stays 22, `MAX_ISOLATED` 10,
`MAX_STILL_AMBIGUOUS` 18 (no `src/cfg/**` change).

Control: `rn-template-0.72/index.android.hbc` at CLI defaults is `cmp`-identical
against the same working tree with only the new block removed — **5,000,113
bytes**. Tests: `joinedChildFunctions("movable")` in
`tests/gate/emit/closure-copies.test.ts`, verified RED in a detached worktree at
`bc596e3` (`_fn3` stubbed, `E_UNBOUND_IDENT` on `_fn4`) and green after, plus
`joinedChildFunctions("pinned")` pinning the guard (the child that reads the
disagreed-about environment must *not* move, and the residue is one `_fn<n>` and
no `_e<env>_<slot>`).

### Remaining work after item 2

0. **(2026-09-05, item 3)** Leftovers 1–3 below are superseded: 3 is fixed, and
   1 + 2 are *not* a placement defect — see "What the 26 remaining unbound names
   actually are" above. The live list is: leftover 4 (the 18 unaligned chains,
   19 of the 26 names, needs Fred), leftover 6
   (`closureNameAt` instance keying, unobservable today), and leftover 7. The
   "new graph bug" (7 names: fn#13056, fn#15251, fn#15275, said to be created
   with several aligned environments the lattice resolves to one) is neither new
   nor a graph bug: they are report §3's *joined* functions and the bug was
   where the emitter put the single body. Fixed — see "Landing item 4" above,
   which leaves **leftover 7**: the one child per re-hosted function that stays
   behind (3 names, `_fn14790`/`_fn15473`/`_fn15478`).

1. **20 `_fn<n>`** — unchanged, and not a duplication defect: functions with no
   resolved creation environment at all (`_fn13056`, `_fn13838`…`_fn13844`,
   `_fn13914`…`_fn14002`, `_fn15251`, `_fn15275`), hosted by
   `src/emit/placement.ts`'s cost rule where the referencing site cannot see
   them.
2. **6 `_e4551_*`** — the same family seen from the environment side, and not
   the "8 `_e2192_0`" item 1 recorded (the count was right, the name was not:
   it is 2 × `_e2192_0` + 3 × `_e4551_0` + 2 × `_e4551_1` + 1 × `_e4551_2`).
   fn#14984, fn#14985 and fn#14986 have `closureEnvOf === null` — the graph says
   they capture nothing — yet their bodies read slots of envs 4551/4552/4553,
   owned by fn#14983/14984/14986. They are orphans, placed by cost, and the cost
   rule cannot make all of those reads visible at once.
3. **2 `_e2192_0`** — `_fn10396__c1` / `_fn10397__c1`. These *are* copies: copy 1
   captures env 2192 (owner fn#3497) and its remap `2190 -> 2192` turns the
   body's `_e2190_0` read into `_e2192_0`. Env 2192's slot 0 exists in the graph
   with **one writer and no readers** (env 2190's slot 0 has two readers), so
   the `let _e2192_0` is never emitted: `ownedEnvSlots` / `envDeclaringFunction`
   choose where an environment's declaration goes from the *recorded* accesses,
   every one of which resolved against copy 0's chain. The fix is to push each
   copy's `envRemap` through the access set before choosing declaration sites,
   so a remapped read declares its variable.
4. The 18 unaligned residual (item 2 of the previous list): chains of different
   length have no positional remap. They need either chain alignment by *owner
   function* rather than by position, or an explicit decision to leave them as
   `W_AMBIGUOUS_CLOSURE_ENV` forever, recorded in `docs/DECISIONS.md`. **This
   one needs Fred**, not an implementer.
5. Inside a copy, `closureNameAt` is still keyed by creation *site*, not by
   instance: a site creating a closure over an environment the instance *owns*
   names the same copy in every instance. Scope-wise that now always resolves
   (the group rule puts the named copy in scope); semantically the inner
   recursion levels of a group collapse onto the outermost one. No unbound name
   reports it, so it needs a trace/equivalence test on such a function rather
   than a ratchet.

6. `closureNameAt` instance keying (was leftover 5): not observable while every
   recursion group's inner copies compose to the same remap as the outer one.
   Watch for a group whose copies capture an environment that is itself
   *remapped* by the enclosing instance — then the instances' bodies differ, the
   shared name binds to the wrong one, and this becomes real. See the addendum
   above.

7. **3 `_fn<n>`, the child that stays behind** (item 4). **Still open after item
   5, and now with a measured reason.** The narrow fix (move a child whose
   creation sites are all inside `f`) landed *with a visibility guard* and moves
   none of these three: each reads a slot of the environment its creator's sites
   disagree about, so moving it trades 3 unbound `_fn<n>` for 4 unbound
   `_e<env>_<slot>` (22 -> 23; see "Landing item 5"). They need one instance per
   creation context — item 1's per-instance `parentOf` — or, equivalently, a
   creation-based `lexicalSubtree` in `namesAgreeAcrossSites` so the join never
   fires for them and they are duplicated instead. Either is a `src/cfg/**` or
   whole-emitter change and needs its own spec. The guarded rule that did land
   is live for the case it is sound for (a child that names only environments
   every site shares) and is covered synthetically.
