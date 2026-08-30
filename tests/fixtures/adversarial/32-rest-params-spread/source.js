// Destructuring/spread: rest parameters in functions

function sum(...nums) {
  let total = 0;
  for (const n of nums) {
    total += n;
  }
  return total;
}

const r1 = sum(1, 2, 3, 4, 5);
print('sum:', r1);

function first_rest(a, b, ...rest) {
  return {
    a: a,
    b: b,
    rest_len: rest.length,
    rest_first: rest[0]
  };
}

const r2 = first_rest(10, 20, 30, 40, 50);
print('first:', r2.a);
print('second:', r2.b);
print('rest_len:', r2.rest_len);
print('rest_first:', r2.rest_first);

// Rest with no extras
const r3 = first_rest(10, 20);
print('rest_empty:', r3.rest_len);
