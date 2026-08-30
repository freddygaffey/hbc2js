// Multi-branch if/else if/else chains with side-effecting conditions.
let log = [];
function check(n) {
  if (log.push('check(' + n + ')') && n < 0) {
    return 'negative';
  } else if (n === 0) {
    return 'zero';
  } else if (n < 10) {
    return 'small';
  } else if (n < 100) {
    return 'medium';
  } else {
    return 'large';
  }
}
for (const n of [-5, 0, 3, 42, 1000]) {
  print(n, '->', check(n));
}
print('side effects:', log.join(' | '));
