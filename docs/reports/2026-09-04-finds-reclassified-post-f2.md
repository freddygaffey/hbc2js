# 2026-09-04 — fuzz campaign finds reclassified (post the family-F2 expr-rebuild fix)

Same 201 campaign finds as `2026-09-04-finds-reclassified-post-fixwave3.md`,
re-run after the family-F2 fix in `src/passes/expr-rebuild/match.ts` (a `for`
header's `init`/`update` are now part of the pass's scans — see the Resolved
row in docs/BUGS.md and spec 02 §8).

Run **on the Mac, not on deb**, deliberately: the finds that this fix targets
are v96 ones, and `deb`'s `tools/hermes-vm` has only v94 and v99 built, so a
deb run cannot reference the v96 VM. Wall clock ~25 min, single process.

| run | PASS | INCONCLUSIVE | DIVERGENT | ERROR |
|---|---|---|---|---|
| post-P-16 | 85 | 73 | 43 | 0 |
| post-fix-wave-3A+3B (deb) | 102 | 90 | 9 | 0 |
| post-F2 fix (this run, Mac) | 99 | 97 | 5 | 0 |

**DIVERGENT 9 -> 5.** The four finds the F2 fix cleared are
`v96-seed780933.js` (the one reduced into
`tests/fixtures/adversarial/46-fuzz-let-capture-branch`), `v99-seed777358.js`,
`v99-seed777578.js` and `v99-seed777648.js` — every find whose signature was
the *value*/branch disagreement the F2 row described.

PASS moved 102 -> 99 and INCONCLUSIVE 90 -> 97: that swing is the
machine, not the fix (INCONCLUSIVE is dominated by timeouts and by which
toolchains the host has; this box is a laptop and the previous run was deb).
No find moved from PASS to DIVERGENT.

The 5 survivors below are **not** the F2 bug — the F2 row had grouped them
together on version alone. Three are one signature (Hermes shares a single
`let` binding across loop iterations, D14; the candidate emits a per-iteration
capture, so the VM prints `16,16,…` where the candidate prints `0,1,2,…`), one
is the known v98 round-trip function-count row, and one is a v99 loop-condition
divergence (`body runs even though condition is false`). They carry their own
Open row in docs/BUGS.md.

Re-ran all 201 saved finds (`reports/fuzz/finds/*.js`) through compile -> decompile -> `runOracleLadder` with the current harness.

| version | total | now PASS (false alarm) | still DIVERGENT | still ERROR | no local toolchain |
|---|---|---|---|---|---|
| v84 | 50 | 17 | 0 | 0 | 0 |
| v94 | 46 | 12 | 1 | 0 | 0 |
| v96 | 45 | 13 | 2 | 0 | 0 |
| v98 | 1 | 0 | 1 | 0 | 0 |
| v99 | 59 | 57 | 1 | 0 | 0 |
| **total** | **201** | **99** | **5** | **0** | **0** |

Distinct surviving signatures: 5.

## Surviving signatures

- `DIVERGENT:trace:     0 - out print "let closures each see own i: 16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16" ["\"let closures each see own i:\"","\"16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16\""]
     0 + out print "let closures each see own i: 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15" ["\"let` — DIVERGENT, 1 find(s), version(s) 94, example `v94-seed780867.js` — traces diverge at record 0 | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:     0 - out print "let closures each see own i: 3,3,3" ["\"let closures each see own i:\"","\"3,3,3\""]
     0 + out print "let closures each see own i: 0,1,2" ["\"let closures each see own i:\"","\"0,1,2\""]
     1   limit timeout:out print "…" ["…"let closures each see own i:\"…",` — DIVERGENT, 1 find(s), version(s) 96, example `v96-seed781844.js` — traces diverge at record 0 | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:     0 - out print "let closures each see own i: 3,3,3" ["\"let closures each see own i:\"","\"3,3,3\""]
     0 + out print "let closures each see own i: 0,1,2" ["\"let closures each see own i:\"","\"0,1,2\""]
     1   limit sync-timeout
     2   globals {}
     3   end:out print "…"` — DIVERGENT, 1 find(s), version(s) 96, example `v96-seed782973.js` — traces diverge at record 0 | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:roundtrip:roundtrip:function count mismatch: original=# recompiled=#` — DIVERGENT, 1 find(s), version(s) 98, example `v98-seed314159.js` — function count mismatch: original=1 recompiled=2
- `DIVERGENT:trace:trace:iterations=-Infinity final n=#
body runs even though condition is false: x=#
body runs even though condition is false: x=#
uncaught RangeError | iterations=-Infinity final n=#
body runs even though condition is false: x=#
body runs even though condition is false: x=#` — DIVERGENT, 1 find(s), version(s) 99, example `v99-seed777142.js` — candidate diverges from Hermes VM v99's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)

