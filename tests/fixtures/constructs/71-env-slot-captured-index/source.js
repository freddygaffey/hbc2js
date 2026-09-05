// Captured base + captured index in the SAME lexical environment, at
// DIFFERENT slots -- docs/BUGS.md 2026-09-01 "captured-variable declaration
// order" row, the multi-slot case 22-nested-closures-counters cannot reach
// (each of its environments holds exactly one captured slot).
//
// Each factory below captures two locals into one environment: the BASE
// (slot 0, the parameter, stored first) and the INDEX/counter (slot 1). The
// nested closures then use the three shapes where ECMAScript evaluates the
// base BEFORE the index and Hermes emits the matching pair of
// `LoadFromEnvironment`s in that order: `arr[i++]` (GetByVal),
// `obj[k++] = v` (PutByVal) and `fn(a, n++)` (a call argument). Each factory
// also exposes a plain reference read of the base AFTER the increment, so a
// rewrite that changed the values rather than just their order would show up
// in expected.txt as well as in the slot sequence.
//
// The invariant this fixture pins: decompiling and recompiling it must not
// swap the two `LoadFromEnvironment` slot immediates inside the nested
// closure (tests/gate/passes/env-slot-order.test.ts).
function makeCursor(arr) {
  var i = 0;
  function next() { return arr[i++]; }
  function base() { return arr.length; }
  function at() { return i; }
  return { next: next, base: base, at: at };
}

function makeWriter(obj) {
  var k = 0;
  function put(v) { obj[k++] = v; return k; }
  function slot() { return obj[0]; }
  return { put: put, slot: slot };
}

function makeInvoker(fn) {
  var n = 0;
  function step(a) { return fn(a, n++); }
  function count() { return n; }
  return { step: step, count: count };
}

var c = makeCursor(['a', 'b', 'c']);
print(c.next());
print(c.next());
print(c.at());
print(c.base());

var w = makeWriter({});
print(w.put('x'));
print(w.put('y'));
print(w.slot());

var v = makeInvoker(function (a, n) { return a + '#' + n; });
print(v.step('p'));
print(v.step('q'));
print(v.count());
