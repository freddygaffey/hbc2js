// Round-trip normaliser demo: the "original" source.
function total(n) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += i * 2;
  }
  return sum;
}
print(total(10));
