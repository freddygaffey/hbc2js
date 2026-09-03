# 2026-09-03 — fuzz campaign finds reclassified (post D14 evidence-based override)

Re-ran all 201 saved finds (`reports/fuzz/finds/*.js`) through compile -> decompile -> `runOracleLadder` with the current harness.

| version | total | now PASS (false alarm) | still DIVERGENT | still ERROR | no local toolchain |
|---|---|---|---|---|---|
| v84 | 50 | 0 | 50 | 0 | 0 |
| v94 | 46 | 4 | 39 | 0 | 0 |
| v96 | 45 | 0 | 42 | 0 | 0 |
| v98 | 1 | 0 | 1 | 0 | 0 |
| v99 | 59 | 0 | 59 | 0 | 0 |
| **total** | **201** | **4** | **191** | **0** | **0** |

Distinct surviving signatures: 80.

## Surviving signatures

- **DIVERGENT** x3 (v84,94,96) — `DIVERGENT:trace:trace:total=#…` — example `v84-seed777054.js`
- **DIVERGENT** x1 (v84) — `DIVERGENT:trace:trace:#:# | #:# | #:# | #:# | #:#…` — example `v84-seed777316.js`
- **DIVERGENT** x1 (v84) — `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#…` — example `v84-seed778046.js`
- **DIVERGENT** x13 (v84,94,96,99) — `DIVERGENT:trace:trace:final i=# sum=#…` — example `v84-seed778059.js`
- **DIVERGENT** x3 (v84,94,96) — `DIVERGENT:trace:trace:final i=Infinity sum=#…` — example `v84-seed778448.js`
- **DIVERGENT** x14 (v84,94,96) — `DIVERGENT:trace:trace:{"…":"…","…":false}…` — example `v84-seed778735.js`
- **DIVERGENT** x2 (v84) — `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#…` — example `v84-seed778870.js`
- **DIVERGENT** x4 (v84,94,96) — `DIVERGENT:trace:trace:{"…":"…","…":false}…` — example `v84-seed778894.js`
- **DIVERGENT** x2 (v84) — `DIVERGENT:trace:trace:let closures each see own i:  | let closures each see own i: …` — example `v84-seed779013.js`
- **DIVERGENT** x3 (v84,94,96) — `DIVERGENT:trace:trace:breaking at i=# computed=#…` — example `v84-seed779419.js`
- **DIVERGENT** x2 (v84,96) — `DIVERGENT:trace:trace:map: a:#,b:#,c:#…` — example `v84-seed779558.js`
- **DIVERGENT** x1 (v84) — `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,Infinity…` — example `v84-seed779709.js`
- **DIVERGENT** x1 (v84) — `DIVERGENT:trace:trace:#,#,#,#,#e+#,#,#,#,#e+#…` — example `v84-seed779831.js`
- **DIVERGENT** x3 (v84,94,96) — `DIVERGENT:trace:trace:{"…":"…","…":"…","…":false,"…":"…"}…` — example `v84-seed779942.js`
- **DIVERGENT** x3 (v84,94,96) — `DIVERGENT:trace:trace:#:# | #:# | #:# | #:# | #:#…` — example `v84-seed781829.js`
- **DIVERGENT** x5 (v84,94,96) — `DIVERGENT:trace:trace:undefined -> #…` — example `v84-seed781885.js`
- **DIVERGENT** x3 (v84,94,96) — `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#e+#…` — example `v84-seed781975.js`
- **DIVERGENT** x1 (v84) — `DIVERGENT:trace:trace:#,#,#,NaN,#,#,#,NaN,#…` — example `v84-seed782241.js`
- **DIVERGENT** x3 (v84,94,96) — `DIVERGENT:trace:trace:map: a:#,b:#,c:#…` — example `v84-seed782758.js`
- **DIVERGENT** x12 (v84,94,96) — `DIVERGENT:trace:trace:| uncaught RangeError` — example `v84-seed783042.js`
- **DIVERGENT** x5 (v84,94,96) — `DIVERGENT:trace:trace:{"…":"…","…":false}…` — example `v84-seed783147.js`
- **DIVERGENT** x1 (v84) — `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#…` — example `v84-seed783451.js`
- **DIVERGENT** x1 (v84) — `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#…` — example `v84-seed783599.js`
- **DIVERGENT** x3 (v84,94,96) — `DIVERGENT:trace:trace:#:# | #:# | #:# | #:# | #:#…` — example `v84-seed783738.js`
- **DIVERGENT** x1 (v84) — `DIVERGENT:trace:trace:first=# rest=[#,#,#] arguments.length=#…` — example `v84-seed783790.js`
- **DIVERGENT** x1 (v84) — `DIVERGENT:trace:trace:#,#,#,Infinity,#,#,#,Infinity,NaN…` — example `v84-seed784319.js`
- **DIVERGENT** x1 (v84) — `DIVERGENT:trace:trace:#,Infinity,#,#,#,Infinity,#,#,#…` — example `v84-seed785508.js`
- **DIVERGENT** x3 (v84,94,96) — `DIVERGENT:trace:trace:#:# | #:# | #:# | #:# | #:#…` — example `v84-seed785753.js`
- **DIVERGENT** x1 (v84) — `DIVERGENT:trace:trace:#,#,#e+#,Infinity,#,#,#e+#,Infinity,#…` — example `v84-seed785948.js`
- **DIVERGENT** x3 (v84,94,96) — `DIVERGENT:trace:trace:iterations=# final n=#…` — example `v84-seed785964.js`
- **DIVERGENT** x3 (v84,94,96) — `DIVERGENT:trace:trace:iterations=-Infinity final n=#…` — example `v84-seed786132.js`
- **DIVERGENT** x3 (v84,94,96) — `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#…` — example `v84-seed786391.js`
- **DIVERGENT** x1 (v84) — `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,-Infinity…` — example `v84-seed786471.js`
- **DIVERGENT** x2 (v84,96) — `DIVERGENT:trace:trace:map: a:#,b:#,c:#…` — example `v84-seed786810.js`
- **DIVERGENT** x2 (v94,96) — `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#…` — example `v94-seed780044.js`
- **DIVERGENT** x2 (v94,96) — `DIVERGENT:trace:trace:#e+#,-Infinity,#e+#,#,#,-Infinity,#e+#,#,-Infinity…` — example `v94-seed782833.js`
- **DIVERGENT** x3 (v94,96) — `DIVERGENT:trace:trace:let closures each see own i: #,#,# | let closures each see own i: #,#,#…` — example `v94-seed782973.js`
- **DIVERGENT** x2 (v94,96) — `DIVERGENT:trace:trace:first=# rest=[#,#,Infinity] arguments.length=#…` — example `v94-seed783159.js`
- **DIVERGENT** x2 (v94,96) — `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#…` — example `v94-seed784166.js`
- **DIVERGENT** x2 (v94,96) — `DIVERGENT:trace:trace:#,#,#,#,NaN,#,#,#,#…` — example `v94-seed784673.js`
- **DIVERGENT** x2 (v94,96) — `DIVERGENT:trace:trace:#,Infinity,#,#,#e+#,Infinity,#,#,#e+#…` — example `v94-seed785176.js`
- **DIVERGENT** x2 (v94,96) — `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,#…` — example `v94-seed785803.js`
- **DIVERGENT** x2 (v94,96) — `DIVERGENT:trace:trace:"…"…` — example `v94-seed785825.js`
- **DIVERGENT** x1 (v96) — `DIVERGENT:trace:trace:map: a:NaN,b:#,c:#…` — example `v96-seed780559.js`
- **DIVERGENT** x1 (v96) — `DIVERGENT:trace:trace:let closures each see own i: #,#,#,#,#,#,#,#,#,#,#,#,#,#,#,# | let closures each see own i: #,#,#,#,#,#,#,#,#,#,#,#,#,…` — example `v96-seed780867.js`
- **DIVERGENT** x1 (v96) — `DIVERGENT:trace:trace:# true…` — example `v96-seed780933.js`
- **DIVERGENT** x1 (v96) — `DIVERGENT:trace:trace:map: a:#,b:#,c:#…` — example `v96-seed781754.js`
- **DIVERGENT** x1 (v98) — `DIVERGENT:roundtrip:roundtrip:function count mismatch: original=# recompiled=#` — example `v98-seed314159.js`
- **DIVERGENT** x11 (v99) — `DIVERGENT:trace:trace:guarded ok: #…` — example `v99-seed777007.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:,#…` — example `v99-seed777080.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:guarded ok: NaN…` — example `v99-seed777090.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:iterations=-Infinity final n=#…` — example `v99-seed777142.js`
- **DIVERGENT** x8 (v99) — `DIVERGENT:trace:trace:uncaught TypeError | start…` — example `v99-seed777154.js`
- **DIVERGENT** x7 (v99) — `DIVERGENT:trace:trace:chain: a=#,b=#,c=#…` — example `v99-seed777243.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:guarded ok: #…` — example `v99-seed777274.js`
- **DIVERGENT** x4 (v99) — `DIVERGENT:trace:trace:uncaught TypeError | guarded caught: boom#…` — example `v99-seed777280.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:other v#…` — example `v99-seed777315.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:# #…` — example `v99-seed777358.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:guarded ok: #…` — example `v99-seed777377.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:uncaught TypeError | guarded caught: boom#…` — example `v99-seed777415.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:chain: a=#,b=#,c=#…` — example `v99-seed777513.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:NaN…` — example `v99-seed777552.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:#…` — example `v99-seed777578.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:chain: a=NaN,b=NaN,c=NaN…` — example `v99-seed777581.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:chain: a=NaN,b=NaN,c=NaN…` — example `v99-seed777591.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:#,x#…` — example `v99-seed777648.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:#…` — example `v99-seed777767.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:chain: a=NaN,b=NaN,c=NaN…` — example `v99-seed777780.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:chain: a=#,b=#,c=#…` — example `v99-seed777810.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:guarded ok: NaN…` — example `v99-seed777862.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:f# x#…` — example `v99-seed777959.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:other #…` — example `v99-seed778025.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:{"…":"…","…":"…","…":false,"…":"…"}…` — example `v99-seed778046.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:#…` — example `v99-seed778055.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:#,#,#,#,#,#,#,#,-Infinity…` — example `v99-seed778058.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:uncaught TypeError | start…` — example `v99-seed778114.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:zero…` — example `v99-seed778123.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:chain: a=Infinity,b=Infinity,caught:too big…` — example `v99-seed778145.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:true,false,b…` — example `v99-seed778158.js`
- **DIVERGENT** x1 (v99) — `DIVERGENT:trace:trace:#,x#…` — example `v99-seed778174.js`
