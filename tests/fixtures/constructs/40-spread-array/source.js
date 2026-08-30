// Spread in array literals and in function call argument lists.
const a = [1, 2, 3];
const b = [0, ...a, 4, ...a, 5];
print(b.join(','));

function sum3(x, y, z) {
  return x + y + z;
}
print(sum3(...a));

function variadicSum(...nums) {
  return nums.reduce(function (acc, n) { return acc + n; }, 0);
}
print(variadicSum(...a, ...b));

const str = 'abc';
print([...str].join('-'));

const copy = [...a];
copy.push(999);
print('original unaffected:', a.join(','), 'copy:', copy.join(','));
