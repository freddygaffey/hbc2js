// Evaluation order: nullish coalescing ?? operator edge cases

let trace = [];

function log(x, v) {
  trace.push(x);
  return v;
}

// ?? only uses right side if left is null or undefined
const r1 = log('a', 0) ?? log('b', 1);  // Should be 0, not 1
const r2 = log('c', null) ?? log('d', 2);  // Should be 2
const r3 = log('e', undefined) ?? log('f', 3);  // Should be 3
const r4 = log('g', false) ?? log('h', 4);  // Should be false

print('r1:', r1);
print('r2:', r2);
print('r3:', r3);
print('r4:', r4);
print('trace:', trace.join('|'));

// Combined with logical operators
const r5 = true && log('i', 10) ?? log('j', 20);
print('r5:', r5);
print('final-trace:', trace.join('|'));
