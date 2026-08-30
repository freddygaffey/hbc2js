// Infinite generator consumed lazily with an early break.
function* naturals() {
  let n = 1;
  while (true) {
    yield n++;
  }
}
function take(iterable, count) {
  const out = [];
  for (const v of iterable) {
    if (out.length >= count) break;
    out.push(v);
  }
  return out;
}
print('first 5 naturals:', take(naturals(), 5).join(','));

function* fibonacci() {
  let [a, b] = [0, 1];
  while (true) {
    yield a;
    [a, b] = [b, a + b];
  }
}
const fibs = [];
for (const v of fibonacci()) {
  if (v > 50) break;
  fibs.push(v);
}
print('fibonacci under 50:', fibs.join(','));
