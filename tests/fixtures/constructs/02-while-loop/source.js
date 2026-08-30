// while loop with an internal break on a computed condition.
let i = 0;
let sum = 0;
while (i < 100) {
  i++;
  const computed = (i * i) % 17;
  if (computed === 0 && i > 1) {
    print('breaking at i=' + i + ' computed=' + computed);
    break;
  }
  sum += i;
}
print('final i=' + i, 'sum=' + sum);

let count = 0;
while (count < 5) {
  print('tick', count);
  count += 1;
}
print('done, count=' + count);
