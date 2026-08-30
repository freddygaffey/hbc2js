// OOP: class expressions and instanceof across inheritance chain

const Base = class {
  getType() {
    return 'base';
  }
};

class Middle extends Base {
  getType() {
    return super.getType() + '-middle';
  }
}

class Derived extends Middle {
  getType() {
    return super.getType() + '-derived';
  }
}

const b = new Base();
const m = new Middle();
const d = new Derived();

print('b.getType():', b.getType());
print('m.getType():', m.getType());
print('d.getType():', d.getType());

print('d instanceof Derived:', d instanceof Derived);
print('d instanceof Middle:', d instanceof Middle);
print('d instanceof Base:', d instanceof Base);

print('m instanceof Middle:', m instanceof Middle);
print('m instanceof Base:', m instanceof Base);
print('m instanceof Derived:', m instanceof Derived);
