# 2026-09-02 — Service NSW superlinear term, part 2 — Sonnet, lean

Removed `expr-rebuild/check.ts`'s `bu = registerUses(before)` — a fresh
`O(list.length)` walk once per applied site, cold every time a top-level
site is matched (`spliceList` gives the edited list a fresh array identity).
`registerUseDelta` computes the write/read delta straight from the
shared-prefix/suffix-stripped changed region — proved equivalent in the
function's own doc comment (the subtraction cancels the shared pre/post
exactly), verified byte-identical by hashing rn-template + three construct
fixtures (v94, passes on) before/after; the rn-template hash is now pinned
as a permanent regression test.

Synthetic 5,000-site benchmark: ~4 s CPU → ~2 s CPU isolated. Not
sub-second: re-profiling shows the residual cost is
`ast.ts`'s `expressionOnlyCheck` → `defUse(after)`, a full un-bounded walk
of `after` once per applied site that part 1 did not narrow (unlike
`effectSequence` and the register-count delta, which are bounded now).
`defUse`'s per-register "no read before its own first def" order check
needs a global first-def position, not just a before/after delta, so the
same shared-prefix/suffix subtraction trick does not directly apply without
extra incremental state (a naive `WeakMap` keyed by list identity does not
help either, since that identity churns exactly like `registerUses`'s did).
Named as the next term in `docs/BUGS.md`'s superlinear-pass row rather than
attempted under this session's budget — a wrong soundness call here is a
correctness bug, not a perf regression. Kept the synthetic benchmark's
budget at the original 15 s (isolated measurement dropped ~4 s → ~2 s, but
`npm test`'s full parallel run on deb's 32 cores measured this same
computation at ~9.3 s CPU under contention — a first attempt to tighten to
6 s failed under full-suite load; the 15 s headroom is deliberately kept,
documented in the test itself).

NSW re-measurement on deb (32-core, `--lenient-env`, same
`~/hbc2js-bulk/corpus/nsw/index.android.bundle` as the 946 s/715 s
baselines): whole-file passes-on **563 s** (was 946 s, 1.68x), 0 stubs, 0
unresolved-env, `node --check` OK, 59.4 MB output. `--split` passes-on
**512 s** (was 715 s on the Mac — different machine, not a clean ratio, but
a real absolute drop), 4,510/4,510 modules. Neither lands under the
~60–120 s target this row's verdict asks for, so `docs/BUGS.md`'s row stays
**open**, updated with real numbers and the `defUse(after)` term named for
part 3.

Full `npm test` on deb: green (typecheck included).
