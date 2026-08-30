// OOP: class private fields and methods

class Counter {
  #value = 0;

  #increment() {
    this.#value++;
  }

  inc() {
    this.#increment();
    return this.#value;
  }

  get value() {
    return this.#value;
  }

  set value(v) {
    this.#value = v;
  }
}

const c = new Counter();
print('initial:', c.value);
const r1 = c.inc();
const r2 = c.inc();
print('after inc:', r1, r2);

c.value = 100;
print('after set:', c.value);
const r3 = c.inc();
print('final:', r3);
