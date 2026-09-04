// Two spread sites that share one staged source register, plus a plain
// element stored after a spread. Hermes stages a spread's source and index
// registers once and reuses them at the next site, so a decompiler pass that
// deletes the first site's staging destroys the second site's operands, and
// an element appended after a spread is stored from a staged register too.
// Regression fixture for fuzz family F1
// (docs/reports/2026-09-04-fuzz-families.md).
const a = [0, 1, 3];
const b = [0, ...a, 1, ...a, 5];
print(b.join(','));

const s = 'abc';
print([...s].join('-'));
print([...s].join('-'));

const copy = [...a];
copy.push(0);
print('original unaffected:', a.join(','), 'copy:', copy.join(','));

const base = { x: 1 };
const clone = { ...base };
clone.x = 2;
const merged = { ...null, ...undefined, y: 1 };
print(JSON.stringify(clone), JSON.stringify(merged));
