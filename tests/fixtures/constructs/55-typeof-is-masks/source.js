// `typeof x <op> "..."` compiles, from HBC 98 on, to `TypeOfIs` / `JmpTypeOfIs`
// with a `TypeOfIsTypes` BITSET operand (include/hermes/FrontEndDefs/Typeof.h,
// vendored per pin). A `!==` test is the COMPLEMENT mask, so a single negated
// comparison already produces a mask with eight of the nine bits set — e.g.
// `typeof x !== "string"` is 507, the mask that used to stop two 30-50 MB
// production bundles. Every branch below is exercised with a value of each
// typeof category so a wrong bit shows up as a wrong answer, not just a
// different shape.
function describe(x) {
  if (typeof x === 'string') return 'S';
  if (typeof x === 'number') return 'N';
  if (typeof x === 'boolean') return 'B';
  if (typeof x === 'undefined') return 'U';
  if (typeof x === 'function') return 'F';
  if (typeof x === 'symbol') return 'Y';
  if (typeof x === 'bigint') return 'G';
  if (typeof x === 'object') return x === null ? 'Z' : 'O';
  return '?';
}

function notString(x) {
  return typeof x !== 'string';
}

function isObjectish(x) {
  // `typeof x === "object"` is the Object|Null pair: it is true for null.
  return typeof x === 'object';
}

function notFunction(x) {
  return typeof x !== 'function';
}

var values = ['s', 0, true, undefined, describe, Symbol('k'), 10n, {}, null, []];

var described = [];
var notStrings = [];
var objectish = [];
var notFunctions = [];
for (var i = 0; i < values.length; i++) {
  described.push(describe(values[i]));
  notStrings.push(notString(values[i]) ? 1 : 0);
  objectish.push(isObjectish(values[i]) ? 1 : 0);
  notFunctions.push(notFunction(values[i]) ? 1 : 0);
}

print('describe:', described.join(''));
print('notString:', notStrings.join(''));
print('typeofObject:', objectish.join(''));
print('notFunction:', notFunctions.join(''));

// A ternary keeps the result in a register instead of a branch, which is the
// non-jump `TypeOfIs` form.
print('ternary:', values.map(function (v) { return typeof v === 'symbol' ? 'y' : 'n'; }).join(''));
