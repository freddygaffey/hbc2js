# 2026-09-04 — fuzz campaign finds reclassified (post fix-wave step 3 A+B)

> **Superseded 2026-09-04** by `2026-09-04-finds-reclassified-post-f2.md`:
> after the family-F2 fix in `src/passes/expr-rebuild/match.ts`, DIVERGENT is
> 9 -> 5. The four cleared finds are `v96-seed780933`, `v99-seed777358`,
> `v99-seed777578`, `v99-seed777648`. The note below that assigns 8 of the 9
> survivors to family F2 is wrong: only those four were the F2 bug.


Same 201 campaign finds as `2026-09-04-finds-reclassified-post-p16.md`,
re-run on the `deb` box (own clone `~/hbc2js-fixwave3`, fnm node v22.23.2)
with the resource-ceiling marker (step 3A) and the missing-global wording
normalisation (step 3B) in place.

| run | PASS | INCONCLUSIVE | DIVERGENT | ERROR |
|---|---|---|---|---|
| post-P-16 (previous) | 85 | 73 | 43 | 0 |
| post-fix-wave-3A+3B (this run) | 102 | 90 | 9 | 0 |

INCONCLUSIVE is the difference between the totals and is not broken out by
the generator (it counts neither as PASS nor as a surviving signature). The
9 survivors below are 4 at v96, 4 at v99 and 1 at v98; the v96/v99 ones are
the family-F2 closure/branch row in docs/BUGS.md (one of them reduced into
`tests/fixtures/adversarial/46-fuzz-let-capture-branch`), the v98 one is the
round-trip function-count row.


Re-ran all 201 saved finds (`reports/fuzz/finds/*.js`) through compile -> decompile -> `runOracleLadder` with the current harness.

| version | total | now PASS (false alarm) | still DIVERGENT | still ERROR | no local toolchain |
|---|---|---|---|---|---|
| v84 | 50 | 15 | 0 | 0 | 0 |
| v94 | 46 | 11 | 0 | 0 | 0 |
| v96 | 45 | 23 | 4 | 0 | 0 |
| v98 | 1 | 0 | 1 | 0 | 0 |
| v99 | 59 | 53 | 4 | 0 | 0 |
| **total** | **201** | **102** | **9** | **0** | **0** |

Distinct surviving signatures: 9.

## Surviving signatures

- `DIVERGENT:trace:     0 - out print "let closures each see own i: 16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16" ["\"let closures each see own i:\"","\"16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16\""]
     0 + out print "let closures each see own i: 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15" ["\"let` — DIVERGENT, 1 find(s), version(s) 96, example `v96-seed780867.js` — traces diverge at record 0 | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:     0   out print "0 true" ["0","true"]
     1   out print "1 true" ["1","true"]
     2   out print "2 true" ["2","true"]
     3 - out print "other false" ["\"other\"","false"]
     3 + out print "f0 threw ReferenceError: t3 is not defined" ["\"f0\"","\"threw\"","\"ReferenceError: t` — DIVERGENT, 1 find(s), version(s) 96, example `v96-seed780933.js` — traces diverge at record 3 | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:     0 - out print "let closures each see own i: 3,3,3" ["\"let closures each see own i:\"","\"3,3,3\""]
     0 + out print "let closures each see own i: 0,1,2" ["\"let closures each see own i:\"","\"0,1,2\""]
     1 - err main RangeError: Invalid array length
     1 + limit sync-tim` — DIVERGENT, 1 find(s), version(s) 96, example `v96-seed781844.js` — traces diverge at record 0 | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:     0 - out print "let closures each see own i: 3,3,3" ["\"let closures each see own i:\"","\"3,3,3\""]
     0 + out print "let closures each see own i: 0,1,2" ["\"let closures each see own i:\"","\"0,1,2\""]
     1   limit sync-timeout
     2   globals {}
     3   end:out print "…"` — DIVERGENT, 1 find(s), version(s) 96, example `v96-seed782973.js` — traces diverge at record 0 | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:roundtrip:roundtrip:function count mismatch: original=# recompiled=#` — DIVERGENT, 1 find(s), version(s) 98, example `v98-seed314159.js` — function count mismatch: original=1 recompiled=2
- `DIVERGENT:trace:trace:# #
false
f# true
#
finally
# ,#
# ,#
f# v#
f# a,#
#,b
outer # | # #
false
f# true
#
finally
# ,#
f# v#
f# a,#
#,b
outer #` — DIVERGENT, 1 find(s), version(s) 99, example `v99-seed777358.js` — candidate diverges from Hermes VM v99's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#
finally
finally
# true
# true
# true
f# NaN
true
zero
f# 
#
finally
f# true
#
true
f# #
outer # | #
finally
finally
# true
f# NaN
true
zero
f# 
#
finally
f# true
#
true
f# #
outer #` — DIVERGENT, 1 find(s), version(s) 99, example `v99-seed777578.js` — candidate diverges from Hermes VM v99's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,x#
finally
# true
# true
# true
f# v-false
f# #
a
outer # | #,x#
finally
# true
f# v-false
f# #
a
outer #` — DIVERGENT, 1 find(s), version(s) 99, example `v99-seed777648.js` — candidate diverges from Hermes VM v99's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#
finally
# false
# false
# false
f# a,#
x#
#
f# #
other #
f# false
f# #
v-a
outer # | #
finally
# false
f# a,#
x#
#
f# #
other #
f# false
f# #
v-a
outer #` — DIVERGENT, 1 find(s), version(s) 99, example `v99-seed777767.js` — candidate diverges from Hermes VM v99's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)

