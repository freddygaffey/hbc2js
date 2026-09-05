// Terminating counterpart of construct-fuzzer find
// reports/fuzz/finds/v99-seed777142.js (campaign seed-base 777000, fuzz
// family F2 residual -- docs/BUGS.md 2026-09-05 fix-wave-4 row).
//
// The find itself can never be a fixture: its third do/while grows an array
// with a counter that `++` cannot advance (`k = -Infinity`), so it runs until
// an engine's array/heap ceiling. That ceiling is what the find was really
// about (Hermes words it `Requested an array size that fails to allocate`
// and aborts heap exhaustion as `LLVM ERROR: OOM`, which the ladder did not
// recognise as a ceiling, so it read two engines hitting the same wall after
// identical output as a divergence). This fixture keeps every construct that
// surrounded that ceiling -- a do/while whose test is a compile-time-false
// constant so the body must still run once, a do/while whose counter is a
// non-advancing -Infinity, Infinity-valued arithmetic reaching an array and
// a join -- and bounds the loop with a separate finite counter so it
// terminates, prints deterministically and can be checked for PASS at every
// compiled version.
var n = 100;
var iterations = -Infinity;
do {
  iterations++;
  n = n - 30;
} while (n > 0);
print('iterations=' + iterations, 'final n=' + n);
var x = 999;
do {
  print('body runs even though condition is false: x=' + x);
} while (false);
var results = [];
var k = -Infinity;
var steps = 0;
do {
  results.push(k * k);
  k++;
  steps++;
} while (steps < 3);
print('squares:', results.join(','));
print('k unchanged by ++:', k, 'steps advanced:', steps);
