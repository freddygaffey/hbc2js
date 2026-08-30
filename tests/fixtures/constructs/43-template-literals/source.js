// Multi-line template literals with embedded expressions and nesting.
const name = 'World';
const items = ['apple', 'banana', 'cherry'];
const simple = `Hello, ${name}!`;
print(simple);

const multiline = `Line one
Line two with ${items.length} items
Line three`;
print(multiline);

const nested = `outer-${`inner-${1 + 1}`}-end`;
print(nested);

const list = `Items: ${items.map(function (it, i) { return `${i}:${it}`; }).join(', ')}`;
print(list);

function computeExpr(a, b) {
  return `${a} + ${b} = ${a + b}, ${a} * ${b} = ${a * b}`;
}
print(computeExpr(3, 4));
