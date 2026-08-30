// for...in over an object with own and inherited enumerable keys.
function Base() {
  this.inheritedProp = 'from-base';
}
Base.prototype.protoEnumerable = 'proto-enumerable';

function Derived() {
  Base.call(this);
  this.ownA = 1;
  this.ownB = 2;
}
Derived.prototype = Object.create(Base.prototype);

const d = new Derived();
Object.defineProperty(d, 'hiddenProp', { value: 'nope', enumerable: false });

const keys = [];
for (const key in d) {
  keys.push(key);
}
print('keys:', keys.sort().join(','));

const plain = { z: 1, a: 2, m: 3 };
const plainKeys = [];
for (const k in plain) {
  plainKeys.push(k + '=' + plain[k]);
}
print('plain:', plainKeys.join(','));
