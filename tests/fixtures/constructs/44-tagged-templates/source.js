// Tagged template function receiving cooked strings, .raw, and substitutions.
function inspect(strings, ...values) {
  const parts = [];
  for (let i = 0; i < strings.length; i++) {
    parts.push('cooked[' + i + ']=' + JSON.stringify(strings[i]));
    parts.push('raw[' + i + ']=' + JSON.stringify(strings.raw[i]));
    if (i < values.length) parts.push('value[' + i + ']=' + JSON.stringify(values[i]));
  }
  return parts.join(' | ');
}
const x = 42;
print(inspect`a\n${x}b\tc${x + 1}d`);

function html(strings, ...values) {
  return strings.reduce(function (acc, s, i) {
    return acc + s + (i < values.length ? String(values[i]) : '');
  }, '');
}
print(html`<p>${'safe & sound'}</p>`);

function firstArgOnly(strings) {
  return strings.length;
}
print('template with no substitutions has 1 string part:', firstArgOnly`no subs here`);
