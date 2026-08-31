// Form field validation: string/number coercion edge cases, loose vs strict
// equality, NaN handling, template literals and typeof dispatch.
const fields = [
  { name: 'age', raw: '42' },
  { name: 'age2', raw: ' 42 ' },
  { name: 'zip', raw: '01234' },
  { name: 'hex', raw: '0x1f' },
  { name: 'empty', raw: '' },
  { name: 'nan', raw: 'abc' },
  { name: 'float', raw: '3.50' },
  { name: 'exp', raw: '1e3' },
  { name: 'neg', raw: '-0' },
  { name: 'bool', raw: true },
  { name: 'nil', raw: null },
  { name: 'undef', raw: undefined },
  { name: 'arr', raw: [7] },
  { name: 'arr2', raw: [1, 2] },
];

function describe(raw) {
  const n = Number(raw);
  const p = parseInt(raw, 10);
  const f = parseFloat(raw);
  const parts = [
    `type=${typeof raw}`,
    `Number=${n}`,
    `parseInt=${p}`,
    `parseFloat=${f}`,
    `isNaN=${Number.isNaN(n)}`,
    `plus=${'' + raw}`,
    `loose0=${raw == 0}`,
    `strict=${raw === 0}`,
    `truthy=${!!raw}`,
  ];
  return parts.join(' ');
}

for (const { name, raw } of fields) print(name + ': ' + describe(raw));

function validate(value, rule) {
  switch (typeof value) {
    case 'string':
      if (rule.trim) value = value.trim();
      if (value.length < (rule.min || 0)) return 'too short';
      return rule.pattern && !rule.pattern.test(value) ? 'pattern' : 'ok';
    case 'number':
      if (value !== value) return 'NaN';
      if (rule.integer && Math.floor(value) !== value) return 'not integer';
      return value < rule.min || value > rule.max ? 'range' : 'ok';
    case 'boolean':
      return rule.required && !value ? 'must accept' : 'ok';
    case 'undefined':
    case 'object':
      return value === null || value === undefined ? (rule.required ? 'missing' : 'ok') : 'unexpected object';
    default:
      return 'unsupported ' + typeof value;
  }
}

const rules = { age: { min: 0, max: 130, integer: true }, name: { trim: true, min: 2, pattern: /^[a-z]+$/i }, terms: { required: true }, nick: {} };
const cases = [
  ['age', 30], ['age', 30.5], ['age', 200], ['age', NaN], ['age', '30'],
  ['name', '  Bo '], ['name', ' x '], ['name', 'B0b'],
  ['terms', false], ['terms', true], ['nick', null], ['nick', undefined], ['nick', {}], ['nick', function () {}],
];
for (const [field, value] of cases) print(`${field}(${typeof value === "function" ? "fn" : String(value)}) -> ${validate(value, rules[field])}`);

// Arithmetic on mixed operands, as bugs in real forms go.
print(['5' * '2', '5' + 2, '5' - 2, 5 + null, 5 + undefined, '3' > '12', 3 > '12', [] + {}, [] == false, [0] == false, '' == 0, null == undefined, null === undefined, NaN == NaN].join('|'));
print([(0.1 + 0.2).toFixed(2), (1234.5678).toFixed(1), (255).toString(16), (255).toString(2), Number('12px'), Number(' '), Number('\n'), 1 / 0, -1 / 0, 0 / 0, -0 === 0, Object.is(-0, 0)].join('|'));
print([7 % 3, -7 % 3, 7 % -3, 2 ** 10, 7 / 2 | 0, -7 / 2 | 0, ~~-3.7, -1 >>> 28, 1 << 31, (1 << 31) >>> 0, 5 & 3, 5 | 3, 5 ^ 3].join('|'));
