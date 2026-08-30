// Destructuring/spread: spread operator with getters

let getterCalls = 0;

const obj = {
  a: 1,
  get b() {
    getterCalls++;
    return 2;
  },
  c: 3
};

// Spreading should call the getter
const spread = { ...obj };

print('a:', spread.a);
print('b:', spread.b);
print('c:', spread.c);
print('getter calls:', getterCalls);

// Spread in array
const arr = [...[10, 20, 30]];
print('array spread:', arr.join(','));

// Spread in destructuring
const { a: x, b: y, c: z } = spread;
print('destructured:', x, y, z);
