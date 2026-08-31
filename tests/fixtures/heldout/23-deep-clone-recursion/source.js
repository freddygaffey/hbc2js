// Recursive structure walking: deep clone with cycle detection (Map),
// deep equality with early exits, path collection, mutual recursion and a
// depth limit that throws.
function deepClone(value, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (let i = 0; i < value.length; i++) {
      if (i in value) out[i] = deepClone(value[i], seen);
    }
    return out;
  }
  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    for (const [k, v] of value) out.set(deepClone(k, seen), deepClone(v, seen));
    return out;
  }
  const out = Object.create(Object.getPrototypeOf(value));
  seen.set(value, out);
  for (const key of Object.keys(value)) out[key] = deepClone(value[key], seen);
  return out;
}

function deepEqual(a, b, depth = 0) {
  if (depth > 20) throw new RangeError('too deep');
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], depth + 1)) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k], depth + 1)) return false;
  }
  return true;
}

function paths(value, prefix = '') {
  if (value === null || typeof value !== 'object') return [prefix + '=' + String(value)];
  const keys = Object.keys(value);
  if (keys.length === 0) return [prefix + (Array.isArray(value) ? '=[]' : '={}')];
  return keys.flatMap((k) => paths(value[k], prefix ? prefix + '.' + k : k));
}

const original = { name: 'root', tags: ['a', , 'c'], nested: { n: 1, list: [{ x: 1 }, { x: NaN }] }, map: new Map([['k', { v: 1 }]]) };
original.self = original;
original.nested.parent = original;
const clone = deepClone(original);
print([clone !== original, clone.self === clone, clone.nested.parent === clone, clone.tags !== original.tags, 1 in clone.tags, clone.map.get('k') !== original.map.get('k'), clone.map.get('k').v].join(','));
clone.nested.list[0].x = 99;
print(original.nested.list[0].x + ' ' + clone.nested.list[0].x);
print(paths({ a: 1, b: { c: [2, { d: null }], e: {} }, f: [] }).join(' '));

print([deepEqual(1, 1), deepEqual(NaN, NaN), deepEqual([1, [2]], [1, [2]]), deepEqual([1, [2]], [1, [3]]), deepEqual({ a: 1 }, { a: 1, b: undefined }), deepEqual({ a: undefined }, { b: undefined }), deepEqual([], {}), deepEqual(null, {}), deepEqual('1', 1)].join(','));
try {
  deepEqual(original, clone);
} catch (e) {
  print('cyclic compare: ' + e.name + ' ' + e.message);
}

// Mutual recursion with early return, plus an accumulator threaded through.
function isEven(n) { return n === 0 ? true : isOdd(n - 1); }
function isOdd(n) { return n === 0 ? false : isEven(n - 1); }
print([isEven(10), isOdd(7), isEven(7), isOdd(0)].join(','));

function flattenDepth(list, depth, acc = []) {
  for (const item of list) {
    if (Array.isArray(item) && depth > 0) flattenDepth(item, depth - 1, acc);
    else acc.push(item);
  }
  return acc;
}
const nested = [1, [2, [3, [4, [5]]]], 6];
print([0, 1, 2, Infinity].map((d) => JSON.stringify(flattenDepth(nested, d))).join(' '));

function permutations(items) {
  if (items.length <= 1) return [items];
  const out = [];
  items.forEach((item, i) => {
    for (const rest of permutations(items.slice(0, i).concat(items.slice(i + 1)))) out.push([item, ...rest]);
  });
  return out;
}
print(permutations(['a', 'b', 'c']).map((p) => p.join('')).join(',') + ' ' + permutations([]).length + ' ' + permutations([1, 2, 3, 4]).length);

// Recursion depth that overflows is caught as a RangeError in both engines.
function recurse(n) { return recurse(n + 1) + 1; }
try { recurse(0); } catch (e) { print('overflow: ' + (e instanceof RangeError)); }
