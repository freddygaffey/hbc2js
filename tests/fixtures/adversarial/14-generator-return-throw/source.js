// Generators/async: .return() and .throw()

function* counter() {
  let i = 0;
  while (true) {
    try {
      yield i++;
    } catch (e) {
      yield 'caught:' + e.message;
      i = 100;
    }
  }
}

const gen = counter();
const v1 = gen.next();
const v2 = gen.next();
const v3 = gen.throw(new Error('boom'));
const v4 = gen.next();
const v5 = gen.return('done');

print('v1:', v1.value);
print('v2:', v2.value);
print('v3:', v3.value);
print('v4:', v4.value);
print('v5:', v5.value, v5.done);
