// Generators/async: yield* delegation

function* inner() {
  yield 1;
  yield 2;
}

function* outer() {
  yield 'start';
  yield* inner();
  yield 'end';
}

const results = [];
for (const v of outer()) {
  results.push(v);
}

print('delegated yields:', results.join(','));

// Also test return value from delegated generator
function* withReturn() {
  return 42;
}

function* delegator() {
  const val = yield* withReturn();
  yield 'got:' + val;
}

const gen = delegator();
const v1 = gen.next();
const v2 = gen.next();
const v3 = gen.next();

print('delegation return:', v1.value, v2.value, v3.done);
