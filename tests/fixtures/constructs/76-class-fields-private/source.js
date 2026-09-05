// A BASE class that has both public field initialisers and #private fields.
// hermesc folds the public initialisers into the constructor's own receiver
// allocation -- `Object.assign(Object.create(new.target.prototype), {...})`,
// the SEEDED form, which `ctor-this` refused as R-CT2 until 2026-09-05 and
// now folds to `Object.assign(this, {...})`.
// What this fixture pins: (a) the seeded allocation folds, so the constructor
// addresses the real `this` (no `new.target.prototype`, no `Object.create`);
// (b) the private half is still the documented residue -- the `#reading` /
// `#peak` names live in module ENVIRONMENT slots here (not in a local
// `Symbol("#name")` store as in 35-class-private-fields) and the accessors
// copy the symbol into a register first, neither of which is a shape
// `private-fields` recognises, so the accesses stay symbol-keyed
// (docs/BUGS.md 2026-09-01 "class private fields").
// NOTE: classes and private names are only supported by v98/v99 among the
// hermesc versions this project fetches -- see versions.txt.
class Meter {
  unit = 'm';
  scale = 1;
  #reading = 0;
  #peak = 0;

  constructor(start) {
    this.#reading = start;
    this.#peak = start;
  }

  add(delta) {
    this.#reading += delta * this.scale;
    if (this.#reading > this.#peak) {
      this.#peak = this.#reading;
    }
    return this.#reading;
  }

  get peak() {
    return this.#peak;
  }

  toString() {
    return this.#reading + this.unit + ' (peak ' + this.#peak + this.unit + ')';
  }
}
const m = new Meter(3);
print('add:', m.add(4));
print('add:', m.add(-2));
print('peak:', m.peak);
print('unit:', m.unit, 'scale:', m.scale);
print('toString:', m.toString());
