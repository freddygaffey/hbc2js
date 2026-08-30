// Closures returning closures (counter/accumulator factories).
function makeCounter(start) {
  let value = start;
  return function step(delta) {
    value += delta;
    return value;
  };
}
const c1 = makeCounter(0);
const c2 = makeCounter(100);
print('c1:', c1(1), c1(2), c1(3));
print('c2:', c2(-10), c2(-20));
print('c1 unaffected by c2:', c1(0));

function makeAccumulatorFactory() {
  return function makeAccumulator() {
    const items = [];
    return function accumulate(x) {
      items.push(x);
      return items.reduce(function (a, b) { return a + b; }, 0);
    };
  };
}
const acc = makeAccumulatorFactory()();
print('acc:', acc(5), acc(10), acc(-3));
