// Regex literals with flags, named capture groups, .exec/.test, String.replace.
// NOTE: named capture groups (?<name>...) are unsupported by v84 -- see versions.txt.
const dateRe = /(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/;
const m = dateRe.exec('Meeting on 2024-03-15 confirmed');
print(m[0], m.groups.year, m.groups.month, m.groups.day);
print('2024-03-15'.replace(dateRe, '$<day>/$<month>/$<year>'));

const wordsRe = /\b\w+\b/g;
const words = [];
let match;
while ((match = wordsRe.exec('the quick brown fox')) !== null) {
  words.push(match[0] + '@' + match.index);
}
print(words.join(','));

print(/^[a-z]+$/i.test('HELLO'));
print(/^[a-z]+$/i.test('HELLO123'));

print('a1b2c3'.replace(/\d/g, function (d) { return '[' + d + ']'; }));
print('one,two,,four'.split(/,/).join('|'));
