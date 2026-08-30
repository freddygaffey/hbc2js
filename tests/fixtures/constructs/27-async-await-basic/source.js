// async function with sequential awaits and a returned value.
function resolveAfter(value) {
  return Promise.resolve(value);
}
async function sequence() {
  print('start');
  const a = await resolveAfter(1);
  print('got a=' + a);
  const b = await resolveAfter(a + 10);
  print('got b=' + b);
  const c = await resolveAfter(a + b);
  print('got c=' + c);
  return a + b + c;
}
sequence().then(function (total) {
  print('total=' + total);
});
print('sync code after call runs first');
