// Regression fixture for docs/BUGS.md `iterable-wording`: __hbc_b_arraySpread
// used to throw a bare `TypeError: is not iterable` with no further text,
// unlike the sibling __hbc_iterBegin helper (destructuring/for-of), which at
// least tried to describe the value -- using a V8/Node-style description that
// turned out not to match the real Hermes VM at all (see the runtime helper's
// __hbc_notIterable and its comment). Both helpers now throw exactly what a
// real Hermes VM throws: a fixed text for null/undefined (Hermes's GetMethod
// ToObject step) and a second fixed text, with no value description, for
// every other non-iterable value.
//
// Spread-as-call-arguments (`Math.max(...x)`) and destructuring (`var [a] =
// x`) both lower through the runtime helpers (CallBuiltin arraySpread /
// IteratorBegin respectively) and stay that way through the readability
// passes, so both exercise the fix directly. Plain array-literal spread
// (`[...x]`) is deliberately NOT used here: `src/passes/spread-rest`
// rewrites a whole-array `__hbc_b_arraySpread` call straight back to native
// `[...x]` syntax for readability, which then runs under Node's own spread
// semantics (a different, pre-existing, already-known Node-vs-Hermes
// divergence, out of this fixture's scope) instead of the helper.
function spreadCall(x) {
  return Math.max(...x);
}
function destructure(x) {
  var [first] = x;
  return first;
}
function tryAll(label, x) {
  try {
    spreadCall(x);
  } catch (e) {
    print(label, 'call-spread', e.constructor.name + ': ' + e.message);
  }
  try {
    destructure(x);
  } catch (e) {
    print(label, 'destructure', e.constructor.name + ': ' + e.message);
  }
}
tryAll('undefined', undefined);
tryAll('null', null);
tryAll('number', 1);
tryAll('object', {});
