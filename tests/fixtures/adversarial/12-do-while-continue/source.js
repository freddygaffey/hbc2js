// Control flow: do-while with continue statement

let count = 0;
let results = [];

do {
  count++;
  if (count === 2) {
    continue;  // skip the push for count=2
  }
  results.push(count);
} while (count < 5);

print('do-while results:', results.join(','));

// Also test break in do-while
let count2 = 0;
let results2 = [];

do {
  count2++;
  if (count2 === 3) {
    break;
  }
  results2.push(count2);
} while (count2 < 5);

print('do-while-break:', results2.join(','));
