// Generator .return() and .throw() interaction with try/finally inside.
function* g1() {
  try {
    yield 1;
    yield 2;
    yield 3;
  } finally {
    print('g1 finally ran (return() triggered it)');
  }
}
const it1 = g1();
print(JSON.stringify(it1.next()));
print(JSON.stringify(it1.return('early-exit')));
print(JSON.stringify(it1.next()));

function* g2() {
  try {
    yield 'start';
    yield 'unreachable';
  } catch (e) {
    print('g2 caught:', e.message);
    yield 'recovered';
  } finally {
    print('g2 finally always runs');
  }
}
const it2 = g2();
print(JSON.stringify(it2.next()));
print(JSON.stringify(it2.throw(new Error('injected-error'))));
print(JSON.stringify(it2.next()));
