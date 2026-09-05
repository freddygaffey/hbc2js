// Several SIBLING environments inside one function.
//
// docs/BUGS.md 2026-09-05 "Residual `diff:LoadFromEnvironment(imm)` bucket".
// react-navigation-example module 681 / fn#683 creates thirteen environments
// in one function: its own `CreateFunctionEnvironment r4, 11` plus twelve more
// `CreateEnvironment`/`CreateFunctionEnvironment` siblings, each holding the
// captures of one small group of closures. That is what an INLINED IIFE looks
// like after `hermesc -O`: the callee is spliced into the caller but keeps its
// own environment, so the caller ends up with several environments side by
// side instead of one.
//
// Our emitter declares every environment a function owns as one flat
// `let _e<env>_<slot>` list in that function's top scope, so recompiling the
// decompiled source gives hermesc a single scope and it allocates a SINGLE
// environment with the slots renumbered end to end: the original
// `CreateFunctionEnvironment(2) / (1) / (3)` with getters reading slots
// (0,1) / (0) / (0,1,2) recompiles to `CreateFunctionEnvironment(6)` with
// getters reading (0,1) / (2) / (3,4,5) -- the `diff:CreateFunctionEnvironment(imm)`
// and `diff:LoadFromEnvironment(imm)` buckets.
//
// Three IIFEs with different capture counts (2, 1, 3) make the renumbering
// unambiguous: every one of the three reader closures moves.
function makeReaders(items) {
  var out = {};
  (function () {
    var a = items[0], b = items[1];
    out.ab = function () { return a + b; };
  })();
  (function () {
    var c = items[2];
    out.c = function () { return c * 10; };
  })();
  (function () {
    var d = items[0], e = items[1], f = items[2];
    out.def = function () { return d + e + f; };
  })();
  return out;
}

var r = makeReaders([1, 2, 3]);
print(r.ab());
print(r.c());
print(r.def());
