// Non-strict arguments aliasing named parameters; arguments.length vs. arity.
function aliasDemo(a, b) {
  arguments[0] = 'changed-via-arguments';
  return a;
}
print(aliasDemo('original', 'b'));

function arityDemo(a, b, c) {
  return 'declared-arity=' + arityDemo.length + ' called-with=' + arguments.length;
}
print(arityDemo(1));
print(arityDemo(1, 2, 3, 4, 5));

function toArray() {
  return Array.prototype.slice.call(arguments).join(',');
}
print(toArray(1, 2, 3));

function sumAll() {
  let total = 0;
  for (let i = 0; i < arguments.length; i++) total += arguments[i];
  return total;
}
print(sumAll(1, 2, 3, 4, 5));

function namedAliasAfterAssign(x) {
  x = 99;
  return arguments[0] === 99;
}
print('reassigning named param updates arguments:', namedAliasAfterAssign(1));
