// BigInt arithmetic, comparisons, and the TypeError from mixing with Number.
// NOTE: BigInt literals are unsupported by v84 -- see versions.txt.
const a = 9007199254740993n;
const b = 2n;
print('add:', String(a + b));
print('mul:', String(a * b));
print('sub:', String(a - b));
print('div:', String(a / b));
print('mod:', String((a + 1n) % b));
print('pow:', String(2n ** 10n));
print('compare:', a > b, a === 9007199254740993n, a < 0n);

try {
  const bad = a + 1;
  print('unreachable:', bad);
} catch (e) {
  print('caught:', e.constructor.name);
}

print('loose equality allowed:', 5n == 5);
print('explicit conversion:', Number(a) === 9007199254740992 || Number(a) === 9007199254740993);
print('BigInt() constructor:', String(BigInt(123)));
