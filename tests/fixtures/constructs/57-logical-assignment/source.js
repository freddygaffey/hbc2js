// Logical assignment (&&=, ||=, ??=), catalogue row 26. The point of the
// fixture is the SHORT-CIRCUIT: the right-hand side must not be evaluated,
// and the target must not be assigned, when the operator short-circuits.
let calls = 0;
function rhs(v) {
  calls++;
  return v;
}

let a = 0;
a ||= rhs('from-or');        // 0 is falsy -> evaluates, assigns
let b = 'kept';
b ||= rhs('never');          // truthy -> short-circuits
let c = 'start';
c &&= rhs('from-and');       // truthy -> evaluates, assigns
let d = '';
d &&= rhs('never');          // falsy -> short-circuits
let e = null;
e ??= rhs('from-nullish');   // null -> evaluates, assigns
let f = 0;
f ??= rhs('never');          // 0 is NOT nullish -> short-circuits
let g;
g ??= rhs('from-undefined'); // undefined -> evaluates, assigns

print(a + ' ' + b + ' ' + c + ' ' + d + ' ' + e + ' ' + f + ' ' + g);
print('rhs calls: ' + calls);

// Property targets: a short-circuited ??= must not write the property at all,
// which a setter can observe.
const seen = [];
const obj = {
  _x: 'has-value',
  get x() { seen.push('get x'); return this._x; },
  set x(v) { seen.push('set x=' + v); this._x = v; },
  _y: undefined,
  get y() { seen.push('get y'); return this._y; },
  set y(v) { seen.push('set y=' + v); this._y = v; },
};
obj.x ??= 'replacement';   // getter returns non-nullish -> no set
obj.y ??= 'filled';        // getter returns undefined  -> set runs
print(seen.join(' | '));
print(obj.x + ' ' + obj.y);

// Nested in a loop, so the compiler cannot constant-fold the branches.
const inputs = [null, 'x', undefined, 0, false];
let hits = 0;
for (let i = 0; i < inputs.length; i++) {
  let v = inputs[i];
  v ??= 'defaulted';
  if (v === 'defaulted') hits++;
}
print('nullish defaults applied: ' + hits);
