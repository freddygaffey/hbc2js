// Object spread merging with later-key-wins override semantics.
const defaults = { theme: 'light', size: 'medium', flag: false };
const overrides = { size: 'large', extra: 'new' };
const merged = { ...defaults, ...overrides };
print(JSON.stringify(merged));

const reversed = { ...overrides, ...defaults };
print(JSON.stringify(reversed));

const withInline = { ...defaults, size: 'inline-wins-because-last' };
print(JSON.stringify(withInline));

const a = { x: 1 };
const b = { ...a };
b.x = 2;
print('original unaffected:', JSON.stringify(a), 'copy:', JSON.stringify(b));

const empty = { ...null, ...undefined, y: 1 };
print('spreading null/undefined is a no-op:', JSON.stringify(empty));
