// Object destructuring with renaming, nested patterns, and defaults.
const { a: renamedA, b: renamedB = 'default-b' } = { a: 1 };
print(renamedA, renamedB);

const { nested: { deep = 'deep-default' } = {} } = { nested: {} };
print('deep:', deep);

const { x, ...others } = { x: 1, y: 2, z: 3 };
print('x=' + x, 'others=' + JSON.stringify(others));

function greet({ name, greeting = 'Hello' } = {}) {
  return greeting + ', ' + name + '!';
}
print(greet({ name: 'World' }));
print(greet({ name: 'Ada', greeting: 'Hi' }));

const { ['computed' + 'Key']: computedVal } = { computedKey: 'found-it' };
print('computed:', computedVal);
