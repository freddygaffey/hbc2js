// Destructured function parameters with defaults evaluated per-call.
let callCount = 0;
function defaultFactory() {
  callCount++;
  return 'generated-' + callCount;
}
function makeUser({ id, name = defaultFactory(), tags = [] } = {}) {
  return id + ':' + name + ':[' + tags.join(',') + ']';
}
print(makeUser({ id: 1 }));
print(makeUser({ id: 2 }));
print(makeUser({ id: 3, name: 'explicit', tags: ['a', 'b'] }));
print('defaultFactory was called', callCount, 'times');

function sumPair([a = 0, b = 0] = []) {
  return a + b;
}
print(sumPair([1, 2]));
print(sumPair([5]));
print(sumPair());
