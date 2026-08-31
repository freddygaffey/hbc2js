// A log-line parser: regexes with g/i/m flags, exec loops driven by
// lastIndex, replace with a callback and $n references, split by regex,
// sticky matching and character classes.
const logText = [
  '2024-01-05 12:00:01 INFO  user=alice action=login ip=10.0.0.1',
  '2024-01-05 12:00:07 WARN  user=bob action=upload size=12MB',
  'garbage line without structure',
  '2024-01-05 12:01:00 ERROR user=alice action=upload err="disk full"',
  '2024-01-05 12:02:30 info  user=carol action=logout',
].join('\n');

const lineRe = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) (\w+)\s+(.*)$/gm;
const kvRe = /(\w+)=("[^"]*"|\S+)/g;

let match;
const records = [];
while ((match = lineRe.exec(logText)) !== null) {
  const [, , month, day, hh, mm, , level, rest] = match;
  const fields = {};
  kvRe.lastIndex = 0;
  let kv;
  while ((kv = kvRe.exec(rest)) !== null) fields[kv[1]] = kv[2].replace(/^"|"$/g, '');
  records.push({ stamp: `${month}/${day} ${hh}:${mm}`, level: level.toUpperCase(), fields, index: match.index });
}
print('parsed ' + records.length + ' of ' + logText.split('\n').length + ' lines; lastIndex reset to ' + lineRe.lastIndex);
for (const r of records) print(`${r.stamp} [${r.level}] ${Object.keys(r.fields).map((k) => k + ':' + r.fields[k]).join(' ')} @${r.index}`);

const byLevel = records.reduce((acc, r) => { acc[r.level] = (acc[r.level] || 0) + 1; return acc; }, {});
print(JSON.stringify(byLevel));

// test() with the g flag is stateful; without it, it is not.
const errRe = /error/gi;
print([errRe.test(logText), errRe.lastIndex > 0, errRe.test(logText), errRe.lastIndex, /error/i.test(logText), /error/.test(logText)].join(','));

// replace with $n, with a function, and with special patterns.
const masked = logText.replace(/user=(\w)(\w*)/g, (m, first, rest) => `user=${first}${'*'.repeat(rest.length)}`);
print(masked.split('\n')[0]);
print('ip=10.0.0.1'.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)/, '$4.$3.$2.$1 ($&) [$$]'));
print('a-b_c d'.replace(/[-_ ]/g, '').replace(/b/, (m, offset, whole) => `<${m}@${offset}/${whole.length}>`));
print('x'.replace('x', '$`$\'') + ' ' + 'aaa'.replace(/a/g, (m, i) => i) + ' ' + 'aaa'.replace('a', 'b') + ' ' + 'aaa'.replaceAll('a', 'b'));

// split with a capturing regex keeps the separators; with a limit truncates.
print(JSON.stringify('k1=v1;k2=v2,k3=v3'.split(/[;,]/)));
print(JSON.stringify('k1=v1;k2=v2,k3=v3'.split(/([;,])/)));
print(JSON.stringify('a1b2c3'.split(/\d/, 2)) + ' ' + JSON.stringify(''.split(/,/)) + ' ' + JSON.stringify('abc'.split('')));

// match with and without g, matchAll, sticky.
print(JSON.stringify('size=12MB size=3KB'.match(/size=(\d+)(\w+)/)) + ' ' + JSON.stringify('size=12MB size=3KB'.match(/size=(\d+)(\w+)/g)) + ' ' + String('nothing'.match(/\d/)));
const all = [...'size=12MB size=3KB'.matchAll(/(\d+)(MB|KB)/g)].map((m) => `${m[1]}${m[2]}@${m.index}`);
print(all.join(' '));
const sticky = /\d+/y;
sticky.lastIndex = 5;
print(String(sticky.exec('size=12MB')) + ' ' + sticky.lastIndex + ' ' + String(sticky.exec('size=12MB')) + ' ' + sticky.lastIndex);

// Character classes, escapes, dotAll-free multiline, unicode escapes, and RegExp from a string.
const escaped = new RegExp('\\b' + 'disk full'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
print([escaped.test(logText), escaped.source, escaped.flags, /^\s*$/.test('   '), /Ab/.test('Ab'), /[^\w\s]/.exec('ok, then')[0], /a.c/.test('a\nc'), /a[\s\S]c/.test('a\nc')].join(' '));
print(['+1 (555) 010-9999', '5550109999', '555-0109', ''].map((s) => /^\+?1?\s*\(?\d{3}\)?[\s-]?\d{3}-?\d{4}$/.test(s)).join(','));
