// Array destructuring with defaults, elisions/holes, and rest.
const [a, b = 99, , d, ...rest] = [1, undefined, 'skipped', 4, 5, 6, 7];
print(a, b, d, rest.join(','));

const [[x1, y1], [x2, y2]] = [[1, 2], [3, 4]];
print('nested:', x1, y1, x2, y2);

let first, second;
[first, second] = [10, 20];
print('swap before:', first, second);
[first, second] = [second, first];
print('swap after:', first, second);

function firstTwo([p, q]) {
  return p + ':' + q;
}
print(firstTwo(['alpha', 'beta', 'gamma']));

const [onlyOne = 'fallback'] = [];
print('default on empty:', onlyOne);
