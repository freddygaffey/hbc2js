// Settings merge as in an app bootstrap: destructuring with defaults, nested
// patterns, rest/spread on objects and arrays, computed keys.
const defaults = { theme: 'light', retries: 3, endpoints: { api: '/api', ws: '/ws' }, flags: ['a', 'b'] };

function merge(base, { theme = base.theme, retries = base.retries, endpoints: { api = base.endpoints.api, ...otherEndpoints } = {}, flags = [], ...rest } = {}) {
  return {
    theme,
    retries,
    endpoints: { ...base.endpoints, api, ...otherEndpoints },
    flags: [...base.flags, ...flags],
    ...rest,
  };
}

function show(label, cfg) {
  const { endpoints, flags, ...scalars } = cfg;
  const keys = Object.keys(scalars).sort();
  print(label + ': ' + keys.map((k) => k + '=' + scalars[k]).join(' ') + ' endpoints=' + JSON.stringify(endpoints) + ' flags=' + flags.join('/'));
}

show('defaults', merge(defaults));
show('dark', merge(defaults, { theme: 'dark' }));
show('ws', merge(defaults, { endpoints: { ws: 'wss://x', metrics: '/m' }, flags: ['c'], debug: true }));
show('undef', merge(defaults, { theme: undefined, retries: null }));

const [first, , third = 'T', ...others] = ['one', 'two', undefined, 'four', 'five'];
print([first, third, others.length, others.join('+')].join(' '));

function swap([a, b]) { return [b, a]; }
let x = 1, y = 2;
[x, y] = swap([x, y]);
print('x=' + x + ' y=' + y);

const key = 'dyn';
const obj = { [key + '1']: 1, [`${key}2`]: 2, ['plain']: 3 };
const { dyn1, dyn2: renamed, missing = 'dflt', ...restObj } = obj;
print([dyn1, renamed, missing, JSON.stringify(restObj)].join(' '));

function stats(...nums) {
  if (nums.length === 0) return 'none';
  const [min, max] = nums.reduce(([lo, hi], n) => [Math.min(lo, n), Math.max(hi, n)], [Infinity, -Infinity]);
  return `min=${min} max=${max} n=${nums.length}`;
}
print(stats());
print(stats(5));
print(stats(...[3, 9, -2], 7));

const nested = { a: { b: { c: [10, 20, { d: 'deep' }] } } };
const { a: { b: { c: [, twenty, { d }] } } } = nested;
print(twenty + ' ' + d);
