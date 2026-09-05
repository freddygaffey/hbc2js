// INTERLEAVED sibling environments: the inlined IIFEs of fixture 75, but with
// their statements scheduled INTO each other by `hermesc -O`.
//
// docs/specs/passes/27-iife-reconstruct.md sections 4 and 7. Fixture 75's
// three inlined IIFEs keep three contiguous runs of statements, so spec 27
// wraps each one back into `(function () { ... })();`. Here each callee
// captures a parameter and hands its reader closure back through an array, and
// the optimiser emits the two environments' stores as
//
//     _e0_0 = a1;  _e1_0 = a2;  arr = new Array(2);  arr[0] = x;  arr[1] = y;
//
// so environment 0's statements (`_e0_0`, `arr[0] = x`) and environment 1's
// (`_e1_0`, `arr[1] = y`) interleave: neither is a contiguous run and spec 27
// refuses both with `overlapping statement ranges` -- the largest refusal on
// react-navigation-example-0.85.3 (757 environments).
//
// src/emit/iife-group.ts can reorder such a group apart only when every pair
// the regrouping swaps provably commutes. Here it does not: `arr[0] = x` is a
// property store, which may run a setter, so this fixture pins the REFUSAL
// (the flat `let _e<env>_<slot>` prologue survives untouched, which is never a
// behaviour change) as well as the interleaved shape itself at v98/v99.
function pair(p, q) {
  var x, y;
  (function () {
    var a = p;
    x = function () { return a; };
  })();
  (function () {
    var b = q;
    y = function () { return b; };
  })();
  return [x, y];
}

function trio(p, q, r) {
  var u, v, w;
  (function () {
    var a = p;
    u = function () { return a; };
  })();
  (function () {
    var b = q;
    v = function () { return b; };
  })();
  (function () {
    var c = r;
    w = function () { return c; };
  })();
  return [u, v, w];
}

var two = pair(3, 4);
print(two[0]() + two[1]());
var three = trio(10, 20, 30);
print(three[0]() + three[1]() + three[2]());
