// Control flow: loop body reassigns the loop variable

let results = [];

for (let i = 0; i < 5; i++) {
  results.push(i);
  if (i === 2) {
    i = 10;  // Skip ahead
  }
}

print('for-loop:', results.join(','));

// While loop with reassignment
let results2 = [];
let j = 0;

while (j < 5) {
  results2.push(j);
  j++;
  if (j === 3) {
    j = 10;  // Skip
  }
}

print('while-loop:', results2.join(','));

// Do-while with reassignment
let results3 = [];
let k = 0;

do {
  results3.push(k);
  k++;
  if (k === 2) {
    k = 100;
  }
} while (k < 5);

print('do-while:', results3.join(','));
