// Generators/async: yield inside try-finally
// The finally block runs even on .return()

function* genWithFinally() {
  try {
    yield 1;
    yield 2;
    yield 3;
  } finally {
    yield 'finally';
  }
}

const gen = genWithFinally();
const v1 = gen.next();
const v2 = gen.next();
const v3 = gen.return('early');  // triggers finally
const v4 = gen.next();

print('v1:', v1.value, v1.done);
print('v2:', v2.value, v2.done);
print('v3:', v3.value, v3.done);
print('v4:', v4.value, v4.done);
