// Evaluation order: short-circuit operators with side effects
// && and || and ?? should short-circuit appropriately

let trace = [];
function log(x) {
  trace.push(x);
  return x;
}

// && short circuits on false
const r1 = log('a1') && log('a2');

// || short circuits on true
const r2 = log('b1') || log('b2');

// ?? with nullish
const r3 = log('c1') ?? log('c2');
const r4 = log('d1') ?? log('d2');

print('trace:', trace.join('|'));
print('r1:', r1);
print('r2:', r2);
print('r3:', r3);
print('r4:', r4);
