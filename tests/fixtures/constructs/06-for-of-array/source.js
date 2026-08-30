// for...of over a plain array, including early break.
const arr = [10, 20, 30, 40, 50];
let sum = 0;
for (const v of arr) {
  sum += v;
  if (v === 30) {
    print('breaking at v=' + v);
    break;
  }
}
print('sum so far=' + sum);

const out = [];
for (const v of arr) {
  out.push(v * 2);
}
print('doubled:', out.join(','));

const sparse = [1, , 3];
const seen = [];
for (const v of sparse) {
  seen.push(String(v));
}
print('sparse (holes become undefined):', seen.join(','));
