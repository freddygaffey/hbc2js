// Destructuring: array holes in destructuring patterns

// Holes skip elements
const [a, , c] = [1, 2, 3];
print('skip-middle:', a, c);

// Rest captures remainder
const [x, ...rest] = [10, 20, 30, 40];
print('x:', x);
print('rest:', rest.join(','));

// Holes with rest
const [first, , ...others] = ['a', 'b', 'c', 'd'];
print('first:', first);
print('others:', others.join(','));

// Destructuring with undefined in array
const [u, v = 'fallback'] = [undefined];
print('u:', u === undefined ? 'undefined' : u);
print('v:', v);

// Nested with holes
const [[inner1, , inner3], [, inner6]] = [[1, 2, 3], [5, 6]];
print('nested:', inner1, inner3, inner6);
