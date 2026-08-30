// Labeled break/continue escaping nested loops.
const found = [];
outer:
for (let i = 0; i < 5; i++) {
  for (let j = 0; j < 5; j++) {
    if (i * j > 6) {
      break outer;
    }
    found.push(i + '*' + j + '=' + (i * j));
  }
}
print('break outer trail:', found.join(' | '));

const skipped = [];
search:
for (let i = 0; i < 4; i++) {
  for (let j = 0; j < 4; j++) {
    if (j === i) {
      continue search;
    }
    skipped.push(i + ',' + j);
  }
}
print('continue outer trail:', skipped.join(' | '));
