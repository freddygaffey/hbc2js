// Minimal reproducer for adversarial 21-class-private-fields (v99):
// a class getter/setter PAIR is lowered by Static Hermes (v98/v99) as two
// DefineOwnGetterSetterByVal instructions, each with the other half
// `undefined`; the VM only touches the half that is defined, the decompiler
// must not clobber the other one. Reading the accessor after the setter has
// been defined is the observable.
class Box {
  constructor() { this._v = 1; }
  get v() { return this._v; }
  set v(x) { this._v = x; }
}
const b = new Box();
print('get after pair:', b.v);
b.v = 7;
print('get after set:', b.v);
