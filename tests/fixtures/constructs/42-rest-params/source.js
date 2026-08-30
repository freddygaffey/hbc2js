// Rest parameters alongside the (non-strict) arguments object.
function combine(first, ...rest) {
  return 'first=' + first + ' rest=[' + rest.join(',') + '] arguments.length=' + arguments.length;
}
print(combine(1, 2, 3, 4));
print(combine('only'));

function reflectArguments(a, b) {
  const fromArgs = [];
  for (let i = 0; i < arguments.length; i++) fromArgs.push(arguments[i]);
  return fromArgs.join(',');
}
print(reflectArguments(1, 2, 3, 4, 5));

function mutateParamAffectsArguments(x) {
  x = 'mutated';
  return arguments[0];
}
print('non-strict arguments aliasing:', mutateParamAffectsArguments('original'));

function restOnly(...all) {
  return all.length + ':' + all.join('-');
}
print(restOnly());
print(restOnly(1, 2, 3));
