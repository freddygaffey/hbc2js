// Evaluation order: comma operator in condition and expression
// The comma operator evaluates left-to-right and returns the rightmost value

let trace = [];
function log(x) {
  trace.push(x);
  return x;
}

// In a condition, comma evaluates both sides
if (log('cond1'), log('cond2')) {
  trace.push('if-body');
}

// In an expression context
const result = (log('expr1'), log('expr2'), 42);

print('trace:', trace.join('|'));
print('result:', result);
