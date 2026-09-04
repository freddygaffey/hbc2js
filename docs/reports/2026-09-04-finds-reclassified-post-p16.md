# 2026-09-04 - all 201 campaign finds re-run after the P-16 harness fix

Produced by `node tools/fuzz/reclassify-finds.mjs` on the `deb` box (32 cores,
own checkout `~/hbc2js-fixwave2`, the Mac working tree rsynced over) at the
P-16 budget-symmetry fix (`src/harness/compare.ts` + `src/harness/ladder.ts`).

**Before** (`docs/reports/2026-09-04-fuzz-families.md`, post the F1 spread-rest
fix): 201 finds = 77 PASS / 124 still failing, of which 110 were family H1
(non-terminating programs whose DIVERGENT verdict was a budget artifact and
moved with machine load).

**After**: 85 PASS, **73 INCONCLUSIVE (budget)** - a verdict the tool table
below has no column for, so they appear in neither right-hand column - 43
DIVERGENT, 0 ERROR, 29 distinct signatures. So 81 of the 110 H1 finds left
DIVERGENT (73 INCONCLUSIVE + 8 that now PASS outright), and the DIVERGENT
total fell 124 -> 43.

Of the 43 that remain, **30 are a newly-visible sub-family**: the candidate
under Node dies with an *uncaught RangeError* (V8's own resource limit - max
string/array length, or the call stack - reached while the mutated program
loops forever) at a point where the real Hermes VM simply keeps running. That
is a Node-engine limit on a non-terminating program, not a decompiler bug, and
it is filed as its own `docs/BUGS.md` row rather than masked here: it is a
genuine one-sided termination difference, so the P-16 rule (both sides must
have hit a budget) deliberately keeps it DIVERGENT. The other 13 are 9 F3
(missing-global ReferenceError wording, all v99), 3 F2 (closure/`let` capture,
v99) and 1 v98 find with no VM.

---

# 2026-09-03 — fuzz campaign finds reclassified (post D14 evidence-based override)

Re-ran all 201 saved finds (`reports/fuzz/finds/*.js`) through compile -> decompile -> `runOracleLadder` with the current harness.

| version | total | now PASS (false alarm) | still DIVERGENT | still ERROR | no local toolchain |
|---|---|---|---|---|---|
| v84 | 50 | 15 | 12 | 0 | 0 |
| v94 | 46 | 9 | 12 | 0 | 0 |
| v96 | 45 | 17 | 4 | 0 | 0 |
| v98 | 1 | 0 | 1 | 0 | 0 |
| v99 | 59 | 44 | 14 | 0 | 0 |
| **total** | **201** | **85** | **43** | **0** | **0** |

Distinct surviving signatures: 29.

## Surviving signatures

- `DIVERGENT:trace:trace:let closures each see own i:  | let closures each see own i: 
uncaught RangeError` — DIVERGENT, 2 find(s), version(s) 84, example `v84-seed779013.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":true} | {"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":true}
uncaught RangeError` — DIVERGENT, 5 find(s), version(s) 84,94, example `v84-seed779464.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:| uncaught RangeError` — DIVERGENT, 6 find(s), version(s) 84,94, example `v84-seed783042.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":true}
{"…":true} | {"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":true}
{"…":true}
uncaught RangeError` — DIVERGENT, 1 find(s), version(s) 84, example `v84-seed783727.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:iterations=# final n=#
body runs even though condition is false: x=# | iterations=# final n=#
body runs even though condition is false: x=#
uncaught RangeError` — DIVERGENT, 2 find(s), version(s) 84,94, example `v84-seed785964.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:iterations=-Infinity final n=#
body runs even though condition is false: x=-Infinity | iterations=-Infinity final n=#
body runs even though condition is false: x=-Infinity
uncaught RangeError` — DIVERGENT, 2 find(s), version(s) 84,94, example `v84-seed786132.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:map: a:#,b:#,c:#
set (dedup): #,#,#,#,#,# | map: a:#,b:#,c:#
set (dedup): #,#,#,#,#,#
uncaught RangeError` — DIVERGENT, 2 find(s), version(s) 84,94, example `v84-seed786810.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:     0 - out print "let closures each see own i: 16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16" ["\"let closures each see own i:\"","\"16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16\""]
     0 + out print "let closures each see own i: 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15" ["\"let` — DIVERGENT, 2 find(s), version(s) 94,96, example `v94-seed780867.js` — traces diverge at record 0 | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:map: a:#,b:#,c:#
set (dedup): #,#,# | map: a:#,b:#,c:#
set (dedup): #,#,#
uncaught RangeError` — DIVERGENT, 1 find(s), version(s) 94, example `v94-seed781754.js` — candidate diverges from Hermes VM v94's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:map: a:#,b:#,c:#
set (dedup): #,-Infinity,#,# | map: a:#,b:#,c:#
set (dedup): #,-Infinity,#,#
uncaught RangeError` — DIVERGENT, 1 find(s), version(s) 94, example `v94-seed782758.js` — candidate diverges from Hermes VM v94's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:let closures each see own i: #,#,# | let closures each see own i: #,#,#
uncaught RangeError` — DIVERGENT, 1 find(s), version(s) 94, example `v94-seed782973.js` — candidate diverges from Hermes VM v94's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
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
- `DIVERGENT:trace:trace:,#
f# ,b
f# false
other true
#,#
v#
f# threw ReferenceError: Property '…' doesn't exist
f# #
true,#
finally
finally
outer # | ,#
f# ,b
f# false
other true
#,#
v#
f# threw ReferenceError: t# is not defined
f# #
true,#
finally
finally
outer #` — DIVERGENT, 1 find(s), version(s) 99, example `v99-seed777080.js` — candidate diverges from Hermes VM v99's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:iterations=-Infinity final n=#
body runs even though condition is false: x=#
body runs even though condition is false: x=#
uncaught RangeError | iterations=-Infinity final n=#
body runs even though condition is false: x=#
body runs even though condition is false: x=#` — DIVERGENT, 1 find(s), version(s) 99, example `v99-seed777142.js` — candidate diverges from Hermes VM v99's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:other v#
f# #
x#

finally
f# threw ReferenceError: Property '…' doesn't exist
outer # | other v#
f# #
x#

finally
f# threw ReferenceError: t# is not defined
outer #` — DIVERGENT, 1 find(s), version(s) 99, example `v99-seed777315.js` — candidate diverges from Hermes VM v99's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
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
- `DIVERGENT:trace:trace:NaN
finally
f# threw ReferenceError: Property '…' doesn't exist
v-true
# #
# #
# #
finally
f# v-true
other a,#
f# a
outer # | NaN
finally
f# threw ReferenceError: t# is not defined
v-true
# #
# #
# #
finally
f# v-true
other a,#
f# a
outer #` — DIVERGENT, 1 find(s), version(s) 99, example `v99-seed777552.js` — candidate diverges from Hermes VM v99's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
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
- `DIVERGENT:trace:trace:f# x#
# false,false
# false,false
# false,false
#
#
f# threw ReferenceError: Property '…' doesn't exist
v#,#
f# true
outer # | f# x#
# false,false
# false,false
# false,false
#
#
f# threw ReferenceError: t# is not defined
v#,#
f# true
outer #` — DIVERGENT, 1 find(s), version(s) 99, example `v99-seed777959.js` — candidate diverges from Hermes VM v99's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:other #
f# #
# #,#
# #,#
# #,#
v#
finally
f# threw ReferenceError: Property '…' doesn't exist
other #,#
f# #
outer # | other #
f# #
# #,#
# #,#
# #,#
v#
finally
f# threw ReferenceError: t# is not defined
other #,#
f# #
outer #` — DIVERGENT, 1 find(s), version(s) 99, example `v99-seed778025.js` — candidate diverges from Hermes VM v99's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#
#
f# threw ReferenceError: Property '…' doesn't exist
other #
f# #
# #
# #
# #
finally
f# #,#
#
# x#
# x#
# x#
f# #,#
outer # | #
#
f# threw ReferenceError: t# is not defined
other #
f# #
# #
# #
# #
finally
f# #,#
#
# x#
# x#
# x#
f# #,#
outer #` — DIVERGENT, 1 find(s), version(s) 99, example `v99-seed778055.js` — candidate diverges from Hermes VM v99's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:zero
#
f# v#
other #
f# threw ReferenceError: Property '…' doesn't exist
other v-#
f# true
v#
# #
f# b,#
outer # | zero
#
f# v#
other #
f# threw ReferenceError: t# is not defined
other v-#
f# true
v#
# #
f# b,#
outer #` — DIVERGENT, 1 find(s), version(s) 99, example `v99-seed778123.js` — candidate diverges from Hermes VM v99's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:true,false,b
f# #
v#
v#
f# threw ReferenceError: Property '…' doesn't exist
outer # | true,false,b
f# #
v#
v#
f# threw ReferenceError: t# is not defined
outer #` — DIVERGENT, 1 find(s), version(s) 99, example `v99-seed778158.js` — candidate diverges from Hermes VM v99's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,x#
f# threw ReferenceError: Property '…' doesn't exist
f# #
#
# #
# #
# #
true,#
# false,x#
# false,x#
f# #
true
true
f# #
outer # | #,x#
f# threw ReferenceError: t# is not defined
f# #
#
# #
# #
# #
true,#
# false,x#
# false,x#
f# #
true
true
f# #
outer #` — DIVERGENT, 1 find(s), version(s) 99, example `v99-seed778174.js` — candidate diverges from Hermes VM v99's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)

