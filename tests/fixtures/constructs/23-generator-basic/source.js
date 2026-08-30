// function* yielding a fixed sequence, consumed with manual .next().
function* sequence() {
  yield 'a';
  yield 'b';
  const x = yield 'c';
  yield 'received:' + x;
  return 'final';
}
const it = sequence();
print(JSON.stringify(it.next()));
print(JSON.stringify(it.next()));
print(JSON.stringify(it.next()));
print(JSON.stringify(it.next('injected')));
print(JSON.stringify(it.next()));

function* counter(max) {
  for (let i = 0; i < max; i++) yield i * i;
}
const squares = [];
for (const v of counter(5)) squares.push(v);
print('squares:', squares.join(','));
