# Review: M5 pass #1 — D12 framework + `loop-cond` + `for-header` (bc3d252, a0936fa)

Reviewer: Claude Opus 5, 2026-08-30. Scope: `src/passes/**`, `tests/gate/passes/**`,
`src/structure/ir.ts`'s `LoopForm`, `src/emit/function.ts`'s `lowerFormedLoop`, D12/D12a/spec 07,
STATUS/catalogue metrics. Review-only on `src` — no `src` edits were made or are proposed as
part of this review beyond the fixes named below.

Method: re-ran `npm test`; re-measured the corpus and the PL-05 baseline claim independently
rather than trusting the commit message; read the recovered functions at all five HBC versions
for fixtures 02/03/04, 11-nested-loops-mixed (nested loops + a source `continue`) and
02-while-loop `.obf`; attacked the D12a import boundary with five forbidden-import forms; built
hand-made trees to try to make a rewrite pass `check` and change semantics; ran the D16a device
round-trip on the attached tablet with passes ON.

## Verdict: **FIX-THEN-MERGE**

The two rewrites are correct, every number in the commit message is exactly right, and the
on-device proof passes with passes enabled. Nothing in the *output* is wrong. What needs fixing
before the ladder's batch 1 lands is the **enforcement** the D12a model rests on: the
import-boundary test has two evasion holes (F1), and no test has ever made a real `check` say
no (F2). Those two are the mechanisms that are supposed to make a pass written by a cheap model
safe to review in isolation, and today neither is load-bearing. F1/F2 are blockers for batch 1,
not for this commit staying in history.

## Claims, re-verified

| Claim | Result |
|---|---|
| `npm test` gate 892/892 | **892 pass / 0 fail** (commit said 889/889; `main` has advanced past it) |
| 501/501 PASS, 0 DIVERGENT | **`gate (real decompiler): {"pass":501,"divergent":0,"inconclusive":0,"error":0}`**, 23 skipped-by-design ✓ |
| 1,573 sites rewritten / 0 abandoned | re-measured over all 736 `constructs/*/v*.hbc` via `--emit-tree`: **1,487 `loop-cond` + 86 `for-header` = 1,573, 0 `abandoned=`** — exact match |
| byte-identical to M4 with `--passes=none` | re-ran the PL-05 comparison (`decompile(..., {passes:{none:true}})` vs a direct `emitModule`) over all 736 files: **720 identical, 0 differ, 16 errored** |

The 16 errors are the v98 layout-ambiguity files that need `resolveV98Ambiguity`; they are the
same 16 that make the run's *identity-decompiler* tier report
`{"pass":485,...,"error":16}`. Pre-existing, unrelated to the passes — but note that the
`501/501` figure and the `485/16` figure in the same test log are two different tiers, and the
commit message quotes only the flattering one without saying which.

## `do…while` promotion: the fix is principled, not fixture-shaped

Read at v84/94/96/98/99. Fixture 03's genuine `do { … } while (n > 0)` stays a `do…while` at
every version. Fixture 04 prints `for (…)`, fixture 02 prints `while (`/`do {`, no `while (true)`
survives anywhere.

The claim that the v96/98/99 mispromotion is really fixed holds, and I checked it by
construction rather than by fixture. Hand-built rotated loop whose first test is **false**
(`r1 = 20; r2 = 10; do { r1++ } while (r1 < r2)` — the body must run once and produce 21):

* `for-header` does **not** match it; the tree stays `loop { block; if { continue } else { break } }`
  and the output stays a `do…while`. Correct.
* Handing the driver a `for-header` whose `match` skips the `firstTestHolds` proof but keeps the
  real `rewrite`/`check`, the site is abandoned with
  `do-while -> for needs a statically-true first test`. So `check` genuinely is an independent
  backstop against a lying matcher.

The promotion therefore rests on a constant-folding proof evaluated through the **emitter's own**
`conditionFor` (`src/passes/tree.ts:179`), not on a version heuristic. That is the right shape
of fix.

## `check` strength

Sound for these two rewrites.

`loop-cond` changes the tree, so the driver's whole-function `reconstruct` + `checkIsomorphic`
is a real guard (P1 edge-set equality, P2 block coverage, P3 undeclared duplication, P4 label
scoping), and it covers the hoist: hoisting a normally-completing exit branch out of the loop
would lose the back edge — and `matchTail` refuses that case up front anyway
(`completesNormally(exit)`, `src/passes/loop-cond/match.ts:117`).

The three hazards named in the brief are all structurally guarded:

* **`continue` targets.** `matchTail` refuses any `continue L` in the statements before the guard
  (`loop-cond/match.ts:106-110`); `for-header` refuses more than one `continue` outright and, in
  head form, refuses any `continue` that is not the body's trailing one
  (`for-header/match.ts:33,66`). A JS `continue` in a `for` runs the step; the tree's does not,
  and that difference is exactly what those two lines exclude.
* **Labelled breaks out of nested loops.** The `tail-labeled` rewrite lifts label `M` from inside
  the loop to around it. `break M` keeps the same successor in both trees, and the matcher only
  allows the lift when the trailing statements cannot complete normally
  (`loop-cond/match.ts:87`), which is what stops the loop's back edge from being lost. The
  round-trip re-proves it per site.
* **D14 `let` bindings.** These passes cannot break per-iteration binding semantics at all:
  `LoopForm.init` is an `Expr`, never a declaration, so the emitter can only ever print
  `for (r1 = 0; …)` and never `for (let i = 0; …)`. Worth stating in the spec as a deliberate
  invariant, because the obvious "make it read nicer" follow-up (`for (let i = …)`) is exactly
  the D14 violation, and nothing currently forbids it.

I did **not** find a rewrite that passes `check` and changes semantics. The closest thing is F3,
which lives in the emitter's reading of the annotation rather than in a pass.

## Findings

### HIGH

**F1 — the D12a import boundary does not actually hold. `tests/gate/passes/imports.test.ts:22,46`.**
Two forbidden-import forms pass the gate. I added each to `src/passes/loop-cond/check.ts` in turn
and re-ran the test (file restored afterwards; `git status src/` clean):

| form added to a pass | test exit | wanted |
|---|---|---|
| `import { conditionFor } from "../../emit/conds.ts";` | 1 | 1 ✓ |
| `export { conditionFor } from "../../emit/conds.ts";` | 1 | 1 ✓ |
| `import { forHeader } from "../for-header/index.ts";` | 1 | 1 ✓ |
| `import "../../emit/conds.ts";` | **0** | 1 ✗ |
| `import { conditionFor } from "./../../emit/conds.ts";` | **0** | 1 ✗ |

Causes: `importsOf` (line 22) requires the `from` clause, so a bare side-effect import is
invisible; and line 46's `if (spec.startsWith("./")) continue;` treats *any* `./`-prefixed
specifier as a sibling, so one extra `./` walks straight out of the pass directory. This is the
single mechanism D12a cites as what makes "a pass can be implemented by a cheap model and
reviewed in isolation" true. Fix, both in `imports.test.ts`:

```ts
// (a) also match `import "x"` with no clause
for (const m of source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) out.push(m[1]!);
// (b) resolve rather than string-match the sibling case
const dirAbs = join(passesDir, dir);
const abs = resolve(dirAbs, spec);
if (abs.startsWith(dirAbs + sep)) continue;   // a real sibling
```

Add each of the five rows above as an assertion over an in-memory source string, so the test
tests itself rather than only the two well-behaved passes that exist today.

**F2 — no test has ever made a real `check` return `ok: false`.**
Both abandonment tests substitute a stub (`framework.test.ts:36` and `loop-cond.test.ts:79`,
each `check: () => ({ ok: false, … })`). Across the whole corpus the real checks fired 1,573
times and refused **0**. So `loop-cond/check.ts` and `for-header/check.ts` are, as committed,
untested code on the one path where they matter — and `src/passes/README.md`'s own checklist
item 3 requires "≥1 site the `check` refuses" per pass. The regression test to add (I ran it; it
passes against the current code) is the false-first-test probe from the section above, as
`tests/gate/passes/for-header.test.ts`:

1. `synthCfg` for `r1 = 20; r2 = 10; do { r1++ } while (r1 < r2); return r1` → assert
   `applied` contains `loop-cond` and **not** `for-header`, and `printTree` still shows the
   unformed `do…while`.
2. the same CFG with a `for-header` variant whose `match` omits the `firstTestHolds` call →
   assert `abandoned` names `for-header` with reason
   `/statically-true first test/`, and that `r.fn.root === fn.root`.

A matching one for `loop-cond/check.ts` (e.g. a head-form site whose test block carries
straight-line instructions, which `check.ts:26` refuses) closes the pair.

### MEDIUM

**F3 — the emitter can silently drop a `for` head's init. `src/emit/function.ts:405-407`.**
`case "loop"` consumes `pendingInit` unconditionally:

```ts
const init = pendingInit;
pendingInit = null;
if (node.form !== undefined && lowerFormedLoop(node, node.form, init, out)) return;
```

None of `lowerFormedLoop`'s four `return false` paths (`function.ts:335`, `:339`, `:349`) push
`init` back, and the caller at `function.ts:379-381` has *already* emitted the preceding block
trimmed to `{ to: init.from }`. So if the emitter ever declines a `for`-annotated loop, the init
assignments disappear from the output — wrong code rather than a refusal, and no test would
notice. Not reachable today, because the passes' `check`s pin the exact shape `lowerFormedLoop`
re-tests; it is reachable the moment a second stage-A loop pass, or the stage-B driver, edits a
formed loop. Fix: on the false path, emit the init before falling back —

```ts
if (node.form !== undefined && lowerFormedLoop(node, node.form, init, out)) return;
if (init !== null) out.push({ k: "expr", expr: init });
```

— or, better, do not trim the pred block until the loop is known to lower as a `for`.

**F4 — `for-header`'s `check` re-derives, it does not independently verify.
`src/passes/for-header/check.ts:24` vs `match.ts:76`.** Both call `firstTestHolds` with the same
arguments; `check` only re-finds `pred` via `parentOf`. Because the rewrite is annotation-only,
the driver's round-trip is vacuous (`README.md` says so), so `firstTestHolds` is the *sole*
guard on the one rewrite in this commit that can change semantics — and it guards itself. A bug
inside `firstTestHolds`/`valueAtLoopEntry` is invisible to both. Ask for a differential test
that actually *runs* the synthesised loop (true-first-test and false-first-test trees) rather
than re-asserting the predicate.

**F5 — mistyped pass names are silent. `src/passes/registry.ts:35,42,50`.**
`node src/cli.ts …/v94.hbc --no-pass nonexistent-pass` exits 0 and disables nothing.
`enabledPasses` filters `only`/`skip` by name without checking the names exist, and
`after`/`before` dependencies naming an unknown pass are skipped by the `if (at !== undefined)`
guards — so `after: ["loop-condd"]` never constrains anything and never complains. That is
precisely the mistake the D12a "cheap model writes the pass" model invites. Fix: validate all
four name lists against the registry and throw `E_PASS_ORDER` (or a CLI usage error for
`--no-pass`) on an unknown name.

### LOW

**F6 — promotion precision is version-dependent, for a fixable reason. `src/passes/tree.ts:141`.**
Fixture 03's third loop prints `for (r1 = 5, r2 = 0; r2 < r1; …)` at v96/98/99 but stays
`do { … } while (…)` at v84/94; `--emit-tree` shows `passes=loop-cond@93,loop-cond@13` with no
`abandoned=`, i.e. `for-header` never matched, so this is matcher precision, not a refusal. Both
forms are correct. The cause is `singleDefConstant`, which requires the register be written
**exactly once in the whole function**. Register allocation reuses registers constantly, so this
fails often: in `11-nested-loops-mixed/v94` the source's real `for (let i = 0; i < 3; i++)`
prints as `do…while` only because `r2` (holding the constant `3`) is reused as a scratch
register *after* the loop (`r2 = undefined`), while the source's genuine outer `do…while` *does*
get promoted to `for`. Backwards from a reader's point of view. A reaching-definition test — "no
def of the register on any path from its entry-block def to `pred`" — instead of "one def in the
function" would recover most of these, at the same soundness.

**F7 — `loop-cond` can never emit a tail-form plain `while`.** A source `while (c) { … }` that
hermesc rotated prints as `do … while (c)` whenever `for-header` cannot find a step slice —
`11-nested-loops-mixed`'s `while (whileCount < 2) { whileCount++; … }` puts the increment at the
*top* of the body, so there is no `for` step and the loop prints as `do…while` at every version.
Correct, but not what was written, and it will be the common case in real bundles. The ladder
wants a `while-promote` rung: the same `firstTestHolds` proof, no init/step required.

**F8 — no `tests/gate/passes/for-header.test.ts`.** `for-header` is covered by two negative
tests living inside `loop-cond.test.ts` (`:49`, `:67`) plus fixtures. Separately, D12a
(`docs/DECISIONS.md:136`) specifies `src/passes/<name>/<name>.test.ts` as part of a pass's file
set; neither pass has one and `imports.test.ts:33` only requires `{index,match,rewrite,check}.ts`.
Pick one and make the test enforce it.

**F9 — `src/passes/README.md` is close to sufficient, with four gaps.**
Judged as the brief asks — could I write a new pass from this page alone? Yes for the shape:
the `Pass` object, the three functions and their purity rules, what the driver does, the import
boundary, PL-06, the CLI incantations and the checklist are all there and are accurate. Four
things I had to open other files to learn:

1. Line 87 says "there is no separate `docs/specs/passes/` directory", which contradicts
   `docs/DECISIONS.md:136` and the four files now sitting in `docs/specs/passes/`. Already
   flagged by Fable in the AGENT-LOG; one of the two must move. An implementer told to read
   "this page + your catalogue row" will not find the ladder's rung spec.
2. The `Match` contract is never stated: the driver splices **the node it called `match` on** and
   ignores `m.root` (`driver.ts:47,66`), and `m.at.offset` is what `--emit-tree` and
   `W_PASS_ABANDONED` print. A pass whose `root` disagrees with the matched node fails silently.
3. "the site is never retried" is true only because `refused` is keyed by node identity and
   post-order reaches descendants first; the actual backstop, `MAX_SITES_PER_PASS`
   (`driver.ts:23`), is not mentioned.
4. The idempotence trick PL-08 demands — annotate so the next `match` returns `null`
   (`form !== undefined`) — is what both passes do and is never written down.

## Device control (D16a)

Device attached, so this is a real result, not INCONCLUSIVE.

`tools/device-roundtrip.sh` (default fresh scaffold, `--variant js`), tablet `HA2APYTS`,
RN 0.72.17, extracted bundle HBC 94, decompiled by the **current pipeline with passes ON**
(the script calls `node src/cli.ts` with no `--passes=none`), exit 0:

```
logcat:   IDENTICAL
screenshot diff:
  full 0.0000%
  content 0.0000%
```

So the `while`/`do…while`/`for` recovery survives a real React Native app on a real device under
production Hermes, across the 3-tap sequence exercising state, a rendered loop, a generator, an
async function and try/catch/finally — not just the sandboxed oracles. This is the per-pass
control D16a was built for and it should be re-run per ladder batch, not per commit.

## Metrics

`docs/STATUS.md:28`'s **3/53 recovered** matches the catalogue exactly: rows 2, 3 and 4 are the
only ones carrying `— recovered`, from two passes (`loop-cond` owns rows 2 *and* 3). The claim is
honest.

The denominator is not. `53` is the *construct-fixture* count; the catalogue index has **27**
rows — 12 `✅ verified`, 10 `✅ single-version`, 1 `⛔ inferred`, 4 compound/other — and the
catalogue row is the unit a pass declares (`catalogue: [n]`, PL-06). Three numbers are being
conflated: passes (2), catalogue rows recovered (3), fixtures de-scaffolded (3 of 53). The
ladder doc should count all three explicitly and keep them apart:

* **rows recovered / rows recoverable today** — 3 of the ~14 `✅ verified` rows. The 10
  `✅ single-version` rows are *not* eligible until re-measured at a second version (PL-06
  refuses them), so they belong in a separate "needs measuring first" bucket with an owner, not
  in the denominator.
* **rungs done / rungs planned** — the ladder's own 30, which is the schedule number.
* **fixtures fully de-scaffolded / 53** — the readability bar a reader actually feels, and the
  one that should carry the "no `while (true)` survives" style assertions.

It should also record that a rung can be a framework fix with no catalogue row at all (PL-06 has
no row type for those — the gap Fable already logged), and that per-version precision differences
like F6/F7 mean "recovered" needs defining as *recovered at every version*, which today it is
not: `for-header` is recovered at v96/98/99 and not at v84/94 for the same fixture 03 loop.
