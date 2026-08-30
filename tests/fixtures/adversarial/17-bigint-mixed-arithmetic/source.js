// Values: BigInt arithmetic mixed with Number (TypeError)

let results = [];

// BigInt alone works
const b1 = 100n + 50n;
results.push('BigInt add:' + b1);

// BigInt * Number throws TypeError
let error = null;
try {
  const bad = 100n * 2;  // Both BigInt is ok
  results.push('BigInt mul:' + bad);
} catch (e) {
  error = e.constructor.name;
}

// Try actual mixed type
try {
  const mixed = 100n + 2;
  results.push('mixed:' + mixed);
} catch (e) {
  results.push('error:' + e.constructor.name);
}

// BigInt comparisons with numbers work
const cmp = 100n > 50;
results.push('cmp:' + cmp);

print('results:', results.join('|'));
