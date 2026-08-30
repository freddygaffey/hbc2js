// Values: Symbol-keyed properties and Symbol.iterator

const sym1 = Symbol('test');
const sym2 = Symbol('test');  // Different symbol despite same description

// Symbols are not equal
print('sym1 === sym2:', sym1 === sym2);

// Symbol-keyed property
const obj = {};
obj[sym1] = 'value1';
obj[sym2] = 'value2';

print('obj[sym1]:', obj[sym1]);
print('obj[sym2]:', obj[sym2]);

// Symbol.iterator custom implementation
const iterable = {
  [Symbol.iterator]() {
    let count = 0;
    return {
      next: () => {
        count++;
        if (count <= 3) {
          return { value: count, done: false };
        }
        return { done: true };
      }
    };
  }
};

const arr = [];
for (const v of iterable) {
  arr.push(v);
}

print('custom iterator:', arr.join(','));
