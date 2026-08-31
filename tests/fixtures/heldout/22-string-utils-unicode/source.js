// String utilities of the kind every app carries: slicing with negative
// indices, padding, code units vs code points, surrogate pairs, search
// loops, case mapping and a tiny word-wrap.
function truncate(s, max, ellipsis = '…') {
  if (s.length <= max) return s;
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, max - 1).join('') + ellipsis;
}
const samples = ['hello world', 'héllo', 'a😀b😀c', '', 'exactly10!'];
for (const s of samples) print(`${JSON.stringify(s)} length=${s.length} points=${Array.from(s).length} trunc5=${truncate(s, 5)} trunc10=${truncate(s, 10)}`);

const emoji = 'a😀b';
print([emoji.length, emoji.charCodeAt(1), emoji.charCodeAt(2), emoji.codePointAt(1), emoji.codePointAt(2), emoji[1] === emoji.slice(1, 2), [...emoji].length, emoji.split('').length].join(','));
print([String.fromCharCode(72, 105), String.fromCodePoint(128512) === '😀', 'ß'.toUpperCase(), 'İ'.toLowerCase().length, 'ABC'.toLowerCase(), 'abc'.toUpperCase()].join(' '));

print(['abcdef'.slice(-3), 'abcdef'.slice(2, -2), 'abcdef'.substring(4, 1), 'abcdef'.substr(-4, 2), 'abcdef'.slice(10), 'abcdef'.charAt(10) === '', 'abcdef'[10], 'abcdef'.at ? 'has-at' : 'no-at'].join('|'));
print(['7'.padStart(3, '0'), 'x'.padEnd(4, 'ab') + '!', 'toolong'.padStart(3), '  trim me  '.trim() + '|', '  x'.trimStart() + '|', 'x  '.trimEnd() + '|', 'ab'.repeat(3), ''.repeat(0) === ''].join(' '));

function countOccurrences(hay, needle) {
  let count = 0, pos = 0;
  if (needle === '') return -1;
  while ((pos = hay.indexOf(needle, pos)) !== -1) { count++; pos += needle.length; }
  return count;
}
print([countOccurrences('banana', 'an'), countOccurrences('aaaa', 'aa'), countOccurrences('abc', 'd'), countOccurrences('abc', ''), 'banana'.lastIndexOf('an'), 'banana'.indexOf('an', 2), 'banana'.includes('nan'), 'banana'.startsWith('nan', 2), 'banana'.endsWith('nan', 5)].join(','));

function wrap(text, width) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line.length + w.length + (line ? 1 : 0) > width) {
      if (line) lines.push(line);
      line = w;
    } else {
      line += (line ? ' ' : '') + w;
    }
  }
  if (line) lines.push(line);
  return lines;
}
print(wrap('the quick brown fox jumps over the lazy dog', 10).map((l) => `[${l}]`).join(''));
print(wrap('', 5).length + ' ' + wrap('supercalifragilistic word', 5).join('/'));

function camelToKebab(s) { return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(); }
function kebabToCamel(s) { return s.replace(/-([a-z])/g, (m, c) => c.toUpperCase()); }
const names = ['backgroundColor', 'fontSize2X', 'URLParser', 'already-kebab', 'x'];
print(names.map((n) => `${n}->${camelToKebab(n)}->${kebabToCamel(camelToKebab(n))}`).join(' '));

// Comparison and sorting of strings is by UTF-16 code unit, not locale.
const words = ['banana', 'Apple', 'cherry', 'apple', 'Banana', '10', '9', 'éclair', 'zebra'];
print(words.slice().sort().join(','));
print(words.slice().sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : a > b ? 1 : 0)).join(','));
print(['a' < 'b', 'a' < 'B', '10' < '9', 10 < 9, 'abc' < 'abd', 'ab' < 'abc', '' < 'a', 'é' > 'z'].join(','));

// Escapes and concatenation identities.
const multi = 'line1\nline2\ttabbed \'quoted\' "double" back\\slash é \x41 \u{1F600}';
print(JSON.stringify(multi) + ' ' + multi.length + ' ' + multi.split('\n').length);
print([String(123) + 4, 1 + 2 + '3', '1' + 2 + 3, '' + null + undefined + true + [1, 2] + {}, `${'a'}`.concat('b', 1, null), ['x', 'y'].join(), ['x', 'y'].join(''), [null, undefined, 1].join('-')].join(' | '));
