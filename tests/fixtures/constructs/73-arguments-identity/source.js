// arguments-object identity: two bare `arguments` reads in the same function
// must denote the SAME object under Hermes ("var a = arguments, b = arguments;
// a === b" is true). Complements 49-arguments-object, which covers content
// (length, indexing, mapped-write) but never object identity.

// Zero declared parameters (unmapped by construction, spec 23 section 1.1):
// two `arguments` reads compared by ===, then each copied with slice.call.
function identityNoParams() {
  var a = arguments;
  var b = arguments;
  return a === b;
}
print(identityNoParams(1, 2, 3));

function sliceEach() {
  var a = arguments;
  var b = arguments;
  var sa = Array.prototype.slice.call(a);
  var sb = Array.prototype.slice.call(b);
  return a === b && sa.join(',') === sb.join(',');
}
print(sliceEach('x', 'y', 'z'));

// Strict-mode function with declared parameters: unmapped regardless of
// param count/simplicity (spec 23 section 4.1), so identity must hold too.
function identityStrict(x, y) {
  'use strict';
  var a = arguments;
  var b = arguments;
  return a === b && x === 1 && y === 2;
}
print(identityStrict(1, 2));

// A fourth shape -- "arguments[i] read after a parameter write in sloppy
// mode" -- is deliberately NOT added here. 49-arguments-object's
// `namedAliasAfterAssign` already covers the one param-write/arguments-read
// shape where the harness's real Hermes VM and plain Node agree (immediate
// single-param write then read, gate-passing at every version); every
// variant tried while building this fixture (two params, a write followed
// by a *later* statement's read, a write after `arguments` has already been
// read once as a bare identifier) made the real Hermes VM disagree with
// Node on whether the write survives at all -- Hermes's own compiler proved
// the write dead and dropped it in some shapes but not others, a genuine
// D14 compiler-optimisation difference, not an arguments-form/decompiler
// bug (`--passes=none` reproduces the same value the real VM does). Per
// this rung's own brief, that sub-case is only added "if the harness's
// Hermes VMs agree with Node" -- they do not, for every non-duplicate shape
// tried, so it is left uncovered here rather than forcing a
// KNOWN_DIVERGENT_FIXTURES entry for a shape this fixture does not need.
