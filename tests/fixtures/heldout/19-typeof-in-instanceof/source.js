// Runtime type dispatch as a serializer does it: typeof across every type,
// `in` on arrays/strings/prototypes, instanceof with reassigned prototypes
// and Symbol.hasInstance, Object.prototype.toString tagging.
const samples = [
  ['undefined', undefined], ['null', null], ['bool', false], ['num', 0], ['nan', NaN], ['str', ''],
  ['sym', Symbol('s')], ['fn', function () {}], ['arrow', () => 1], ['gen', function* () {}],
  ['arr', []], ['obj', {}], ['date-like', { getTime() { return 0; } }], ['re', /x/], ['err', new Error('e')],
  ['map', new Map()], ['boxedNum', new Number(1)], ['boxedStr', new String('s')], ['args', (function () { return arguments; })()],
];
for (const [label, v] of samples) {
  const tag = Object.prototype.toString.call(v).slice(8, -1);
  print(`${label}: typeof=${typeof v} tag=${tag} isArray=${Array.isArray(v)} truthy=${!!v}`);
}

function serialize(v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string': return JSON.stringify(v);
    case 'number': return Number.isFinite(v) ? String(v) : 'null';
    case 'boolean': return String(v);
    case 'undefined':
    case 'function':
    case 'symbol': return '<skipped ' + typeof v + '>';
    case 'object':
      if (Array.isArray(v)) return '[' + v.map(serialize).join(',') + ']';
      if (v instanceof Error) return '{"error":' + JSON.stringify(v.message) + '}';
      if (v instanceof Map) return '{' + [...v].map(([k, x]) => JSON.stringify(String(k)) + ':' + serialize(x)).join(',') + '}';
      return '{' + Object.keys(v).map((k) => JSON.stringify(k) + ':' + serialize(v[k])).join(',') + '}';
  }
  return '?';
}
print(serialize({ a: [1, 'two', null, undefined, () => 0, NaN], e: new Error('bad'), m: new Map([['k', [true]]]), s: Symbol('x'), n: { deep: -0 } }));

// `in` checks keys, not values; on arrays, indices; on strings, only via the wrapper.
const arr = ['a', 'b'];
print(['0' in arr, 1 in arr, 2 in arr, 'length' in arr, 'map' in arr, 'a' in arr, 'push' in Object.create(arr)].join(','));
const wrapped = new String('hi');
print([0 in wrapped, 'length' in wrapped, 5 in wrapped, 'toUpperCase' in wrapped].join(','));
try { 'x' in 'string'; } catch (e) { print('in on primitive: ' + e.name); }
const withProto = Object.create({ inherited: 1 });
withProto.own = undefined;
print([ 'inherited' in withProto, 'own' in withProto, withProto.own === undefined, withProto.hasOwnProperty('inherited'), Object.keys(withProto).join()].join(','));
delete withProto.own;
print('after delete: ' + ('own' in withProto));

// instanceof follows the *current* prototype chain, not the constructor name.
function A() {}
function B() {}
const a = new A();
print([a instanceof A, a instanceof B, a instanceof Object, A.prototype instanceof Object].join(','));
Object.setPrototypeOf(a, B.prototype);
print([a instanceof A, a instanceof B, a.constructor === B].join(','));
A.prototype = {};
print('old instance after prototype swap: ' + (new A() instanceof A) + ' ' + (Object.getPrototypeOf(a) === B.prototype));

// Symbol.hasInstance customizes instanceof; primitives are never instances by default.
const Even = { [Symbol.hasInstance](n) { return typeof n === 'number' && n % 2 === 0; } };
print([2 instanceof Even, 3 instanceof Even, 'x' instanceof Even, 4.0 instanceof Even].join(','));
print([1 instanceof Number, new Number(1) instanceof Number, 's' instanceof String, Object('s') instanceof String, (() => 0) instanceof Function, Object instanceof Function, Function instanceof Object].join(','));
try { ({}) instanceof 5; } catch (e) { print('instanceof non-callable: ' + e.name); }
try { ({}) instanceof {}; } catch (e) { print('instanceof plain object: ' + e.name); }

// typeof on undeclared names is safe; on TDZ-free vars fine; on a class it is 'function'.
print(typeof undeclaredGlobal + ' ' + typeof Symbol + ' ' + typeof Symbol() + ' ' + typeof typeof 1 + ' ' + typeof void 0 + ' ' + typeof (() => {}).bind(null) + ' ' + typeof null + ' ' + typeof new Boolean(false));
print([typeof NaN === 'number', NaN !== NaN, Number.isNaN('x'), isNaN('x'), Object.is(NaN, NaN), [NaN].includes(NaN), [NaN].indexOf(NaN)].join(','));
