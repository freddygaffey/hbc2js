// OOP: class static initializers and static blocks

let trace = [];

class MyClass {
  static counter = 0;

  static {
    trace.push('static-block-1');
    MyClass.counter = 10;
  }

  static {
    trace.push('static-block-2');
    MyClass.counter += 5;
  }

  static getCounter() {
    return MyClass.counter;
  }

  constructor() {
    trace.push('constructor');
  }
}

trace.push('before-new');
const instance = new MyClass();
trace.push('after-new');

print('trace:', trace.join('|'));
print('counter:', MyClass.getCounter());
