// Destructuring: nested destructuring with side-effecting defaults

let evalCount = 0;
function getDefault() {
  evalCount++;
  return 'default-' + evalCount;
}

// Destructuring with defaults - defaults only evaluated if needed
const { a = getDefault(), b = getDefault() } = { a: 10 };

print('a:', a);
print('b:', b);
print('eval count:', evalCount);  // should be 1 (only b's default evaluated)

// Nested destructuring with defaults
let evalCount2 = 0;
function getDefault2() {
  evalCount2++;
  return 'nested-' + evalCount2;
}

const { x, y: { z = getDefault2() } = {} } = { x: 1 };

print('x:', x);
print('z:', z);
print('eval count2:', evalCount2);
