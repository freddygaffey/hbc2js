// Destructuring/spread: destructuring in function parameters with defaults

let trace = [];

function track(x) {
  trace.push('track:' + x);
  return x;
}

// Destructuring params with defaults
function test1({ a = track(1), b = track(2) } = {}) {
  return a + ':' + b;
}

const r1 = test1({ a: 10 });  // b uses default
const r2 = test1({});  // both use defaults
const r3 = test1();  // object itself defaults to {}

print('test1-a:', r1);
print('test1-b:', r2);
print('test1-c:', r3);

trace = [];

// Array destructuring in params
function test2([x = track(100), y = track(200)] = []) {
  return x + ',' + y;
}

const r4 = test2([1]);
const r5 = test2([]);
const r6 = test2();

print('test2-a:', r4);
print('test2-b:', r5);
print('test2-c:', r6);
