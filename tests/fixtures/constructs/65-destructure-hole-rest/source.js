// Array-pattern holes and rest, at function-body scope (not inside a __pc-
// tracked region) -- docs/BUGS.md 2026-09-02, docs/specs/passes/16-destructure.md
// §2.3 (holes) and §2.4 (rest). Plain-assignment form (rather than a `const`/
// `let [..] = ` declaration) sidesteps an unrelated v84 TDZ-init quirk
// (`__hbc_empty`) that fuses into the array pattern's own prologue block for
// a declaration form and would otherwise refuse the whole unit for a reason
// having nothing to do with holes or rest.
function skipMiddle(xs) {
  let a, c;
  [a, , c] = xs;
  return a + ':' + c;
}
function headAndTail(xs) {
  let h, t;
  [h, ...t] = xs;
  return h + ':' + t.join(',');
}
print(skipMiddle([1, 2, 3]));
print(headAndTail([4, 5, 6]));
