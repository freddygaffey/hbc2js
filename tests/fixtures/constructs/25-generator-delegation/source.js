// yield* delegating to another generator/iterable.
function* inner() {
  yield 'i1';
  yield 'i2';
  return 'inner-return';
}
function* outer() {
  yield 'before';
  const innerResult = yield* inner();
  yield 'inner returned: ' + innerResult;
  yield* [10, 20, 30];
  yield* 'ab';
  yield 'after';
}
const collected = [];
for (const v of outer()) collected.push(String(v));
print(collected.join(' | '));

function* delegatesToArray() {
  yield* ['x', 'y', 'z'];
}
print([...delegatesToArray()].join(','));
