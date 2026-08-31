// Tagged templates as an i18n / formatting layer: strings vs raw,
// evaluation order of substitutions, nested templates, and a tag that
// returns a function.
const order = [];
function trace(name, value) { order.push(name); return value; }

function html(strings, ...values) {
  const escape = (v) => String(v).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
  return strings.reduce((out, s, i) => out + s + (i < values.length ? escape(values[i]) : ''), '');
}

const user = '<b>Kim</b>';
const count = 3;
print(html`<p>Hello ${trace('user', user)}, you have ${trace('count', count)} & ${trace('pl', count === 1 ? 'message' : 'messages')}</p>`);
print('evaluated in order: ' + order.join(','));

function raw(strings, ...values) {
  return strings.raw.map((s, i) => s + (i < values.length ? `{${values[i]}}` : '')).join('') + ' | cooked=' + strings.join('#') + ' | len=' + strings.length + '/' + strings.raw.length;
}
print(raw`line1\nline2 ${1} tab\t${2}\u0041`);
print(raw``);
print(raw`${'only'}`);
print(String.raw`C:\path\${'x'}\n` + ' ' + `C:\\path\\${'x'}\\n`.length);

// A tag returning a function makes a translation with deferred parameters.
const dictionary = { 'Hello {0}, {1} new': { fr: 'Bonjour {0}, {1} nouveaux', de: 'Hallo {0}, {1} neu' } };
function t(strings, ...keys) {
  const template = strings.reduce((acc, s, i) => acc + s + (i < keys.length ? `{${i}}` : ''), '');
  return function (locale, ...args) {
    const text = (dictionary[template] && dictionary[template][locale]) || template;
    return text.replace(/\{(\d+)\}/g, (m, i) => String(args[i] !== undefined ? args[i] : `?${keys[i]}?`));
  };
}
const greet = t`Hello ${'name'}, ${'n'} new`;
print(greet('fr', 'Ana', 5));
print(greet('de', 'Ana', 0));
print(greet('xx', 'Ana'));
print(greet('fr'));

// Nested templates, expressions, and the identity of the strings array.
const items = ['a', 'b', 'c'];
print(`list: ${items.map((x, i) => `${i + 1}. ${x.toUpperCase()}${i < items.length - 1 ? ';' : ''}`).join(' ')} total=${items.length > 2 ? `${items.length} (many)` : 'few'}`);
const seen = [];
function identity(strings) { seen.push(strings); return strings; }
for (let i = 0; i < 2; i++) identity`same site ${i}`;
identity`same text`;
identity`same text`;
print('same call site reuses strings: ' + (seen[0] === seen[1]) + ', different sites: ' + (seen[2] === seen[3]) + ', frozen: ' + Object.isFrozen(seen[0]));

// Substitution coercion goes through ToString, not valueOf-first like +.
const obj = { valueOf: () => 42, toString: () => 'str' };
print(`${obj} ` + (obj + 1) + ` ${[1, [2, 3]]} ${null} ${undefined} ${Symbol('s').toString()} ${{}}`);
const money = (strings, ...vals) => strings.reduce((o, s, i) => o + s + (i < vals.length ? (typeof vals[i] === 'number' ? vals[i].toFixed(2) : vals[i]) : ''), '');
print(money`Total: ${19.5} for ${3} items at ${'various'} prices, tax ${0.075 * 100}%`);
