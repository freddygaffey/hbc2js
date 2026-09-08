# rn-template passes-on diff at the finally-dedup landing (pin 6c2f2dbe -> 35bb93de)

Generated 2026-09-08 by the orchestrator from `decompileTree` on `tests/fixtures/bundles/rn-template-0.72/index.android.hbc` before (32e39b58) and after (7565320f, agent/finally-dedup-2 merged). 95170 lines both sides; 12 lines differ, all at the three sites the rung folds (fn#446 `on`, fn#2074 `Ce`, fn#3177): each `try` gains its `finalizer=`/`copies=` annotation and `finally-dedup` joins the passes list. No line is added or removed anywhere else.

```diff
@@ -7455,14 +7455,14 @@
 ; fn#445 "an"  {"blocks":1,"duplicated":0,"dispatchVars":0,"maxNesting":1,"labels":0,"expansion":1}
 return b0
 
-; fn#446 "on"  {"blocks":7,"duplicated":0,"dispatchVars":0,"maxNesting":6,"labels":0,"expansion":1}  passes=if-chain@0
+; fn#446 "on"  {"blocks":7,"duplicated":0,"dispatchVars":0,"maxNesting":6,"labels":0,"expansion":1}  passes=finally-dedup@42,if-chain@0
 block b0
 if b0 {
   return b5
 } else {
 }
 block b1
-try r0 (head b6) {
+try r0 (head b6) finalizer=b4[1,3) copies=[b3[0,2)] {
   block b2
   return b3
 } catch r0 {
@@ -45038,14 +45038,14 @@
 ; fn#2073 "Pe"  {"blocks":1,"duplicated":0,"dispatchVars":0,"maxNesting":1,"labels":0,"expansion":1}
 return b0
 
-; fn#2074 "Ce"  {"blocks":7,"duplicated":0,"dispatchVars":0,"maxNesting":6,"labels":0,"expansion":1}  passes=if-chain@0
+; fn#2074 "Ce"  {"blocks":7,"duplicated":0,"dispatchVars":0,"maxNesting":6,"labels":0,"expansion":1}  passes=finally-dedup@42,if-chain@0
 block b0
 if b0 {
   return b5
 } else {
 }
 block b1
-try r0 (head b6) {
+try r0 (head b6) finalizer=b4[1,3) copies=[b3[0,2)] {
   block b2
   return b3
 } catch r0 {
@@ -71913,7 +71913,7 @@
 }
 return b2
 
-; fn#3177 ""  {"blocks":8,"duplicated":0,"dispatchVars":0,"maxNesting":8,"labels":1,"expansion":1}  passes=if-chain@0
+; fn#3177 ""  {"blocks":8,"duplicated":0,"dispatchVars":0,"maxNesting":8,"labels":1,"expansion":1}  passes=finally-dedup@48,if-chain@0
 L0: {
   block b0
   if b0 {
@@ -71922,7 +71922,7 @@
   } else {
   }
   block b1
-  try r0 (head b7) {
+  try r0 (head b7) finalizer=b4[1,3) copies=[b3[0,2)] {
     block b2
     block b3
     break L0
```
