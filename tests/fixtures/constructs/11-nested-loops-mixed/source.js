// for inside while inside do/while, mixed control flow.
let outerCount = 0;
const trail = [];
do {
  outerCount++;
  let whileCount = 0;
  while (whileCount < 2) {
    whileCount++;
    for (let i = 0; i < 3; i++) {
      if (i === 1 && whileCount === 2) continue;
      trail.push(outerCount + '.' + whileCount + '.' + i);
    }
  }
} while (outerCount < 2);
print(trail.join(' | '));
print('outerCount=' + outerCount);
