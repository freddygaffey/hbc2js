# 2026-09-04 — fuzz campaign finds re-triaged under the fixed matched-compiler oracle (post P-14)

Re-ran all 201 saved finds (`reports/fuzz/finds/*.js`) through compile -> decompile -> `runOracleLadder` with the current harness (`matchedCompilerReference: true`, P-14 fix). The 42 now-PASS finds are all v99 — exactly the toolchain-artifact set quantified in `2026-09-04-toolchain-artifact-investigation.md`; no other version moved.

| version | total | now PASS (false alarm) | still DIVERGENT | still ERROR | no local toolchain |
|---|---|---|---|---|---|
| v84 | 50 | 0 | 50 | 0 | 0 |
| v94 | 46 | 0 | 46 | 0 | 0 |
| v96 | 45 | 0 | 45 | 0 | 0 |
| v98 | 1 | 0 | 1 | 0 | 0 |
| v99 | 59 | 42 | 17 | 0 | 0 |
| **total** | **201** | **42** | **159** | **0** | **0** |

Distinct surviving signatures: 64.

## Surviving signatures

- `DIVERGENT:trace:trace:total=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=` — DIVERGENT, 3 find(s), version(s) 84,94,96, example `v84-seed777054.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#:# | #:# | #:# | #:# | #:#
total=#
i=# j=# dummy=NaN
i=# j=# dummy=NaN
i=# j=# dummy=NaN
i=# j=# dummy=NaN
i=# j=# dummy=NaN
i=# j=# dummy=NaN
i=# j=# dummy=NaN
i=# j=# dummy=NaN
i=# j=# dummy=NaN
i=# j=# dummy=NaN
i=# j=# dummy=NaN
i=# j=# dummy=NaN
i=# j=# dummy=NaN
i=# j=# ` — DIVERGENT, 1 find(s), version(s) 84, example `v84-seed777316.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#
#
#
#
a-b-c
original unaffected: #,#,# copy: #,#,#,# | #,#,#,#,,#,#,#,#
#
#
NaN
a-b-c
original unaffected: #,#,# copy: #,#,#,#` — DIVERGENT, 1 find(s), version(s) 84, example `v84-seed778046.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:final i=# sum=#
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tic` — DIVERGENT, 13 find(s), version(s) 84,94,96,99, example `v84-seed778059.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:final i=Infinity sum=#
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tick #
tic` — DIVERGENT, 3 find(s), version(s) 84,94,96, example `v84-seed778448.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":true} | {"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":true}
uncaught RangeError` — DIVERGENT, 14 find(s), version(s) 84,94,96, example `v84-seed778735.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#
#
#
a-b-c
original unaffected: #,#,# copy: #,#,#,# | #,#,#,#,#,#,#,#,#
#
#
a-b-c
original unaffected: #,#,# copy: #,#,#,` — DIVERGENT, 2 find(s), version(s) 84, example `v84-seed778870.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
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
uncaught RangeError` — DIVERGENT, 4 find(s), version(s) 84,94,96, example `v84-seed778894.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:let closures each see own i:  | let closures each see own i: 
uncaught RangeError` — DIVERGENT, 2 find(s), version(s) 84, example `v84-seed779013.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:breaking at i=# computed=#
final i=# sum=#
tick #
tick -Infinity
tick -Infinity
tick -Infinity
tick -Infinity
tick -Infinity
tick -Infinity
tick -Infinity
tick -Infinity
tick -Infinity
tick -Infinity
tick -Infinity
tick -Infinity
tick -Infinity
tick -Infinity
tick -Infinity
tic` — DIVERGENT, 3 find(s), version(s) 84,94,96, example `v84-seed779419.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:map: a:#,b:#,c:#
set (dedup): #,#,#,#,# | map: a:#,b:#,c:#
set (dedup): #,#,#,#,#
uncaught RangeError` — DIVERGENT, 3 find(s), version(s) 84,94,96, example `v84-seed779558.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,Infinity
#
Infinity
a-b-c
original unaffected: #,#,# copy: #,#,#,# | #,#,#,#,#,#,#,#,Infinity
#
Infinity
a-b-c
original unaffected: #,#,# copy: #,#,#,` — DIVERGENT, 1 find(s), version(s) 84, example `v84-seed779709.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,#,#,#,#e+#,#,#,#,#e+#
#
NaN
a-b-c
original unaffected: #,#,# copy: #,#,#,# | #,#,#,#,,#,#,#,
#
NaN
a-b-c
original unaffected: #,#,# copy: #,#,#,#` — DIVERGENT, 1 find(s), version(s) 84, example `v84-seed779831.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:{"…":"…","…":"…","…":false,"…":"…"}
{"…":"…","…":"…","…":"…","…":false}
{"…":"…","…":"…","…":false}
original unaffected: {"…":#e+#} copy: {"…":#}
spreading null/undefined is a no-op: {"…":#} | {"…":"…","…":"…","…":false,"…":"…"}
{"…":"…","…":"…","…":"…","…":false}
{"…":"…","…":` — DIVERGENT, 3 find(s), version(s) 84,94,96, example `v84-seed779942.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#:# | #:# | #:# | #:# | #:#
total=#
i=# j=-Infinity dummy=#
i=# j=-Infinity dummy=#
i=# j=-Infinity dummy=#
i=# j=-Infinity dummy=#
i=# j=-Infinity dummy=#
i=# j=-Infinity dummy=#
i=# j=-Infinity dummy=#
i=# j=-Infinity dummy=#
i=# j=-Infinity dummy=#
i=# j=-Infinity dummy=#
i=` — DIVERGENT, 3 find(s), version(s) 84,94,96, example `v84-seed781829.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:undefined -> #
undefined -> #
undefined -> #
undefined -> #
undefined -> #
undefined -> #
undefined -> #
undefined -> #
undefined -> #
undefined -> #
undefined -> #
undefined -> #
undefined -> #
undefined -> #
undefined -> #
undefined -> #
undefined -> #
undefined -> #
undefine` — DIVERGENT, 5 find(s), version(s) 84,94,96, example `v84-seed781885.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#e+#
#
#e+#
a-b-c
a-b-c
original unaffected: #,#,# copy: #,#,#,# | #,#,#,#,#,#,#,#,#e+#
#
#e+#
a-b-c
uncaught TypeError` — DIVERGENT, 3 find(s), version(s) 84,94,96, example `v84-seed781975.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,#,#,NaN,#,#,#,NaN,#
NaN
NaN
a-b-c
original unaffected: #,#,NaN copy: #,#,NaN,# | #,#,#,NaN,,#,#,NaN,#
NaN
NaN
a-b-c
original unaffected: #,#,NaN copy: #,#,NaN,#` — DIVERGENT, 1 find(s), version(s) 84, example `v84-seed782241.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:map: a:#,b:#,c:#
set (dedup): #,-Infinity,#,# | map: a:#,b:#,c:#
set (dedup): #,-Infinity,#,#
uncaught RangeError` — DIVERGENT, 3 find(s), version(s) 84,94,96, example `v84-seed782758.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:| uncaught RangeError` — DIVERGENT, 17 find(s), version(s) 84,94,96, example `v84-seed783042.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false} | {"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false}
{"…":"…","…":false}
uncaught RangeError` — DIVERGENT, 5 find(s), version(s) 84,94,96, example `v84-seed783147.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#
#
#e+#
a-b-c
original unaffected: #,#,# copy: #,#,#,# | #,#,#,#,,#,#,#,#
#
NaN
a-b-c
original unaffected: #,#,# copy: #,#,#,#` — DIVERGENT, 1 find(s), version(s) 84, example `v84-seed783451.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#
#
NaN
a-b-c
a-b-c
original unaffected: #,#,# copy: #,#,#,# | #,#,#,#,#,#,#,#,#
#
NaN
a-b-c
uncaught TypeError` — DIVERGENT, 1 find(s), version(s) 84, example `v84-seed783599.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#:# | #:# | #:# | #:# | #:#
total=#e+#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#
i=# j=# dummy=#` — DIVERGENT, 3 find(s), version(s) 84,94,96, example `v84-seed783738.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:first=# rest=[#,#,#] arguments.length=#
first=only rest=[] arguments.length=# | first=# rest=[#,#,#] arguments.length=#
first=only rest=[] arguments.length=#
uncaught RangeError` — DIVERGENT, 1 find(s), version(s) 84, example `v84-seed783790.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,#,#,Infinity,#,#,#,Infinity,NaN
Infinity
NaN
a-b-c
original unaffected: #,#,Infinity copy: #,#,Infinity,# | #,#,#,Infinity,,#,#,Infinity,NaN
Infinity
NaN
a-b-c
original unaffected: #,#,Infinity copy: #,#,Infinity,#` — DIVERGENT, 1 find(s), version(s) 84, example `v84-seed784319.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,Infinity,#,#,#,Infinity,#,#,#
Infinity
NaN
a-b-c
original unaffected: Infinity,#,# copy: Infinity,#,#,# | #,Infinity,#,#,#,Infinity,#,#,#
Infinity
NaN
a-b-c
original unaffected: Infinity,#,# copy: Infinity,#,#,` — DIVERGENT, 1 find(s), version(s) 84, example `v84-seed785508.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#:# | #:# | #:# | #:# | #:#
#:# | #:# | #:# | #:# | #:#
total=#
i=# j=-Infinity dummy=#
i=# j=-Infinity dummy=#
i=# j=-Infinity dummy=#
i=# j=-Infinity dummy=#
i=# j=-Infinity dummy=#
i=# j=-Infinity dummy=#
i=# j=-Infinity dummy=#
i=# j=-Infinity dummy=#
i=# j=-Infinity dummy=` — DIVERGENT, 3 find(s), version(s) 84,94,96, example `v84-seed785753.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,#,#e+#,Infinity,#,#,#e+#,Infinity,#
Infinity
Infinity
a-b-c
a-b-c
original unaffected: #,#e+#,Infinity copy: #,#e+#,Infinity,# | #,#,#e+#,Infinity,#,#,#e+#,Infinity,#
Infinity
Infinity
a-b-c
uncaught TypeError` — DIVERGENT, 1 find(s), version(s) 84, example `v84-seed785948.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:iterations=# final n=#
body runs even though condition is false: x=# | iterations=# final n=#
body runs even though condition is false: x=#
uncaught RangeError` — DIVERGENT, 3 find(s), version(s) 84,94,96, example `v84-seed785964.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:iterations=-Infinity final n=#
body runs even though condition is false: x=-Infinity | iterations=-Infinity final n=#
body runs even though condition is false: x=-Infinity
uncaught RangeError` — DIVERGENT, 3 find(s), version(s) 84,94,96, example `v84-seed786132.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#
#
#
a-b-c
original unaffected: #,#,# copy: #,#,#,# | #,#,#,#,,#,#,#,#
#
NaN
a-b-c
original unaffected: #,#,# copy: #,#,#,#` — DIVERGENT, 3 find(s), version(s) 84,94,96, example `v84-seed786391.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,-Infinity
#
-Infinity
a-b-c
a-b-c
original unaffected: #,#,# copy: #,#,#,# | #,#,#,#,#,#,#,#,-Infinity
#
-Infinity
a-b-c
uncaught TypeError` — DIVERGENT, 1 find(s), version(s) 84, example `v84-seed786471.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:map: a:#,b:#,c:#
set (dedup): #,#,#,#,#,# | map: a:#,b:#,c:#
set (dedup): #,#,#,#,#,#
uncaught RangeError` — DIVERGENT, 3 find(s), version(s) 84,94,96, example `v84-seed786810.js` — candidate diverges from Hermes VM v84's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#
#
#
a-b-c
original unaffected: #,#,# copy: #,#,#,#
original unaffected: #,#,# copy: #,#,#,# | #,#,#,#,#,#,#,#,#
#
#
a-b-c
original unaffected: #,#,# copy: #,#,#,function (...args           )            {
      emit({ k: "…", ch, s: hermesRender(args), a: args.` — DIVERGENT, 2 find(s), version(s) 94,96, example `v94-seed780044.js` — candidate diverges from Hermes VM v94's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:map: a:NaN,b:#,c:#
set (dedup): #,#,#,# | map: a:NaN,b:#,c:#
set (dedup): #,#,#,#
uncaught RangeError` — DIVERGENT, 2 find(s), version(s) 94,96, example `v94-seed780559.js` — candidate diverges from Hermes VM v94's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:let closures each see own i: #,#,#,#,#,#,#,#,#,#,#,#,#,#,#,# | let closures each see own i: #,#,#,#,#,#,#,#,#,#,#,#,#,#,#,#
uncaught RangeError` — DIVERGENT, 2 find(s), version(s) 94,96, example `v94-seed780867.js` — candidate diverges from Hermes VM v94's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:map: a:#,b:#,c:#
set (dedup): #,#,# | map: a:#,b:#,c:#
set (dedup): #,#,#
uncaught RangeError` — DIVERGENT, 2 find(s), version(s) 94,96, example `v94-seed781754.js` — candidate diverges from Hermes VM v94's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#e+#,-Infinity,#e+#,#,#,-Infinity,#e+#,#,-Infinity
-Infinity
-Infinity
-Infinity
a-b-c
original unaffected: -Infinity,#e+#,# copy: -Infinity,#e+#,#,# | #e+#,-Infinity,#e+#,#,#,-Infinity,#e+#,#,-Infinity
-Infinity
-Infinity
-Infinity
a-b-c
original unaffected: -Infinity,#e+#,# c` — DIVERGENT, 2 find(s), version(s) 94,96, example `v94-seed782833.js` — candidate diverges from Hermes VM v94's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:let closures each see own i: #,#,# | let closures each see own i: #,#,#
uncaught RangeError` — DIVERGENT, 3 find(s), version(s) 94,96, example `v94-seed782973.js` — candidate diverges from Hermes VM v94's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:first=# rest=[#,#,Infinity] arguments.length=#
first=only rest=[] arguments.length=# | first=# rest=[#,#,Infinity] arguments.length=#
first=only rest=[] arguments.length=#
uncaught RangeError` — DIVERGENT, 2 find(s), version(s) 94,96, example `v94-seed783159.js` — candidate diverges from Hermes VM v94's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#
#
#e+#
a-b-c
a-b-c
original unaffected: #,#,# copy: #,#,#,# | #,#,#,#,#,#,#,#,#
#
#e+#
a-b-c
uncaught TypeError` — DIVERGENT, 2 find(s), version(s) 94,96, example `v94-seed784166.js` — candidate diverges from Hermes VM v94's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,#,#,#,NaN,#,#,#,#
#,#,#,#,NaN,#,#,#,#
#
NaN
a-b-c
original unaffected: #,#,# copy: #,#,#,# | #,#,#,#,NaN,#,#,#,#
#,#,#,#,NaN,#,#,#,#
#
NaN
a-b-c
original unaffected: #,#,# copy: #,#,#,` — DIVERGENT, 2 find(s), version(s) 94,96, example `v94-seed784673.js` — candidate diverges from Hermes VM v94's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,Infinity,#,#,#e+#,Infinity,#,#,#e+#
Infinity
Infinity
a-b-c
original unaffected: Infinity,#,# copy: Infinity,#,#,# | #,Infinity,#,#,,Infinity,#,#,
Infinity
NaN
a-b-c
original unaffected: Infinity,#,# copy: Infinity,#,#,#` — DIVERGENT, 2 find(s), version(s) 94,96, example `v94-seed785176.js` — candidate diverges from Hermes VM v94's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#
#
#e+#
a-b-c
original unaffected: #,#,# copy: #,#,#,# | #,#,#,#,#,#,#,#,#
#
#e+#
a-b-c
original unaffected: #,#,# copy: #,#,#,` — DIVERGENT, 2 find(s), version(s) 94,96, example `v94-seed785803.js` — candidate diverges from Hermes VM v94's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:"…"
unparseable
attempt # failed, no binding needed
attempt # failed, no binding needed
attempt # failed, no binding needed
attempt # failed, no binding needed
attempt # failed, no binding needed
attempt # failed, no binding needed
attempt # failed, no binding needed
attempt # ` — DIVERGENT, 2 find(s), version(s) 94,96, example `v94-seed785825.js` — candidate diverges from Hermes VM v94's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
- `DIVERGENT:trace:trace:# true
# true
# true
other false
f# b
# #
# #
# a
f# 
other true
f# false
# true
# true
# true
f# v-true
outer # | # true
# true
# true
other false
f# b
# #
# #
# a
f# 
other true
f# false
# true
f# v-true
outer #` — DIVERGENT, 1 find(s), version(s) 96, example `v96-seed780933.js` — candidate diverges from Hermes VM v96's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
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
- `DIVERGENT:trace:trace:{"…":"…","…":"…","…":false,"…":"…"}
{"…":"…","…":"…","…":"…","…":false}
{"…":"…","…":"…","…":false}
original unaffected: {"…":#} copy: {"…":#}
spreading null/undefined is a no-op: {"…":#}
spreading null/undefined is a no-op: {"…":#} | {"…":"…","…":"…","…":false,"…":"…"}
{"…":"…` — DIVERGENT, 1 find(s), version(s) 99, example `v99-seed778046.js` — candidate diverges from Hermes VM v99's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
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
- `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,-Infinity
#
NaN
a-b-c
original unaffected: #,#,# copy: #,#,#,# | #,#,#,#,#,#,#,#,-Infinity
#
NaN
a-b-c
original unaffected: #,#,# copy: #,#,#,` — DIVERGENT, 1 find(s), version(s) 99, example `v99-seed778058.js` — candidate diverges from Hermes VM v99's own execution of the original bytecode | shares the trace run above (opts.fuzz > 0 drives the fuzz-only records within it)
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

