// Evaluation order: optional chaining with side effects

let trace = [];

function log(x) {
  trace.push(x);
  return x === null ? null : { value: x * 2 };
}

// Should short-circuit on null
const r1 = log(10)?.value;
const r2 = log(null)?.value;  // Should not access .value
const r3 = log(20)?.value?.toString();

print('r1:', r1);
print('r2:', r2);
print('r3:', r3);
print('trace:', trace.join('|'));

// Optional call
const obj = {
  method: function() {
    trace.push('method-called');
    return 'result';
  }
};

trace = [];
const r4 = obj.method?.();
const r5 = null.method?.();  // Should not error

print('method result:', r4);
print('null method result:', r5);
print('call trace:', trace.join('|'));
