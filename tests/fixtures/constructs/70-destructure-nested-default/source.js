// Nested per-element defaults inside an array pattern -- docs/BUGS.md
// 2026-09-02 row, docs/specs/passes/16-destructure.md ss2.2. Function-body
// scope, plain-assignment form (matches 65-destructure-hole-rest's
// methodology, sidestepping the unrelated v84 `__hbc_empty` TDZ-init quirk
// a `const`/`let [..] =` declaration form would hit).
//
// Measured directly at every version (v84/v94/v96/v98/v99), in statement
// position AND in a parameter-default position: once an array pattern's
// element is itself a compound pattern (a nested array or a nested object),
// Hermes always wraps the whole destructuring in its `__pc`-tracked
// exception-safety region -- even with no default at all anywhere in the
// pattern, even at function-body scope, even as a parameter default. The
// inner extraction can throw (a non-iterable nested-array source, a
// null/undefined nested-object source) and the outer iterator must be
// closed on that throw, so Hermes reaches for the same general try/catch
// machinery it uses for array rest (ss2.4). This is the same class of
// "inherently pc-tracked" shape as array rest, not a top-level-only
// artifact: out of v1 scope by precondition 6 (`pc-tracked-region`), not a
// code gap. The sound extension is ss8 Q1's already-named follow-up (match
// the region including its handler against the canonical abrupt-close
// expansion), not a matcher change in this rung.
function nestedArrayDefault(xs) {
  let a, b;
  [a = 1, [b = 2]] = xs;
  return a + ':' + b;
}
function nestedObjectDefault(ys) {
  let x;
  [{x = 3}] = ys;
  return x;
}
print(nestedArrayDefault([9, [10]]));
print(nestedArrayDefault([9, []]));
print(nestedObjectDefault([{x: 20}]));
print(nestedObjectDefault([{}]));
