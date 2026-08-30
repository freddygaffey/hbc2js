// Closures: IIFE returning closures

const makeCounter = (() => {
  let count = 0;

  return {
    increment: () => ++count,
    decrement: () => --count,
    get: () => count,
    reset: () => { count = 0; }
  };
})();

const v1 = makeCounter.increment();
const v2 = makeCounter.increment();
const v3 = makeCounter.decrement();
const v4 = makeCounter.get();

print('increment:', v1, v2);
print('decrement:', v3);
print('final:', v4);

makeCounter.reset();
const v5 = makeCounter.get();
print('after reset:', v5);
