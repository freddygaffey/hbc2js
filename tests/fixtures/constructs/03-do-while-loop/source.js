// do/while executing its body at least once before the test fails.
let n = 100;
let iterations = 0;
do {
  iterations++;
  n = n - 30;
} while (n > 0);
print('iterations=' + iterations, 'final n=' + n);

let x = 999;
do {
  print('body runs even though condition is false: x=' + x);
} while (false);

let results = [];
let k = 0;
do {
  results.push(k * k);
  k++;
} while (k < 5);
print('squares:', results.join(','));
