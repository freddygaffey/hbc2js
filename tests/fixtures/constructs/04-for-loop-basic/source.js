// Classic for with multiple init/update expressions (comma operator).
let trace = [];
for (let i = 0, j = 10; i < j; i++, j--) {
  trace.push(i + ':' + j);
}
print(trace.join(' | '));

let total = 0;
for (let a = 1, b = 100; a < b; a += 2, b -= 5) {
  total += a + b;
}
print('total=' + total);

for (let i = 0; i < 3; i++) {
  for (let j = 0, dummy = (i * 10); j < 2; j++) {
    print('i=' + i, 'j=' + j, 'dummy=' + dummy);
  }
}
