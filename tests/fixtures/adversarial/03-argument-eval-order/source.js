// Evaluation order: arguments evaluated left-to-right with side effects

let calls = [];
function track(name, value) {
  calls.push(name);
  return value;
}

function fn(a, b, c) {
  return a + b + c;
}

const result = fn(
  track('first', 10),
  track('second', 20),
  track('third', 30)
);

print('result:', result);
print('call order:', calls.join(','));  // should be first,second,third
