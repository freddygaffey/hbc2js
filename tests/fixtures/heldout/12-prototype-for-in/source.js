// for-in over prototype chains: shadowing, non-enumerable properties,
// hasOwnProperty filtering, null-prototype objects and integer-like keys.
function Base() {
  this.ownBase = 1;
}
Base.prototype.protoMethod = function () { return 'pm'; };
Base.prototype.shared = 'base';
Object.defineProperty(Base.prototype, 'hidden', { value: 'h', enumerable: false });

function Derived() {
  Base.call(this);
  this.ownDerived = 2;
  this.shared = 'shadowed';
}
Derived.prototype = Object.create(Base.prototype);
Derived.prototype.constructor = Derived;
Derived.prototype.derivedProto = true;

var d = new Derived();
var all = [];
var own = [];
for (var key in d) {
  all.push(key + '=' + (typeof d[key] === 'function' ? 'fn' : d[key]));
  if (Object.prototype.hasOwnProperty.call(d, key)) own.push(key);
}
print('all: ' + all.join(' '));
print('own: ' + own.join(',') + ' | keys: ' + Object.keys(d).join(','));
print('hidden in d: ' + ('hidden' in d) + ', d.hidden=' + d.hidden + ', constructor enumerable: ' + Object.prototype.propertyIsEnumerable.call(Derived.prototype, 'constructor'));

// Integer-like keys enumerate first in ascending order, then strings in insertion order.
var mixed = { b: 1, 10: 'ten', a: 2, 2: 'two', '01': 'not-int', '-1': 'neg', 1.5: 'float' };
var order = [];
for (var k in mixed) order.push(k);
print('order: ' + order.join(','));

// Shadowing a prototype property with an own one lists it once, in the own position.
var proto = { visible: 1, alsoVisible: 2 };
var child = Object.create(proto);
Object.defineProperty(child, 'visible', { value: 'own', enumerable: true, writable: false, configurable: true });
child.extra = 3;
child.visible = 'ignored (non-writable)';
var seen = [];
for (var k2 in child) seen.push(k2 + '=' + child[k2]);
print('shadowed: ' + seen.join(','));

// Object.create(null) has no prototype noise; `in` still works.
var bare = Object.create(null);
bare.x = 1;
bare.toString = 'not a function';
var bareKeys = [];
for (var k3 in bare) bareKeys.push(k3 + ':' + typeof bare[k3]);
print('bare: ' + bareKeys.join(',') + ' hasOwn via call: ' + Object.prototype.hasOwnProperty.call(bare, 'x') + ' proto: ' + Object.getPrototypeOf(bare));

// Adding to a prototype after the fact affects every live instance.
var instances = [new Derived(), new Base()];
Base.prototype.late = 'late';
print(instances.map(function (o) { var ks = []; for (var k4 in o) ks.push(k4); return ks.length; }).join(','));

// for-in over arrays and strings hands back string keys; over a function, only own enumerables.
var arrKeys = [];
for (var idx in ['p', 'q']) arrKeys.push(typeof idx + ':' + idx);
var strKeys = [];
for (var sIdx in 'hi') strKeys.push(sIdx);
function fn() {}
fn.meta = 'm';
var fnKeys = [];
for (var fk in fn) fnKeys.push(fk);
print(arrKeys.join(' ') + ' | ' + strKeys.join(',') + ' | ' + fnKeys.join(',') + ' | prototype enumerable: ' + Object.prototype.propertyIsEnumerable.call(fn, 'prototype'));

// Object.entries / Object.assign / spread copy only own enumerable properties.
var copy = Object.assign({}, d);
var spread = { ...d };
print(Object.keys(copy).join(',') + ' == ' + Object.keys(spread).join(',') + ' entries=' + Object.entries(d).map(function (e) { return e.join(':'); }).join(';'));
print(JSON.stringify(d) + ' ' + JSON.stringify(child) + ' ' + JSON.stringify(bare));
