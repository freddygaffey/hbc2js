// Values: -0 vs 0 identity and arithmetic

const zero = 0;
const negZero = -1 * zero;  // Create -0

// == comparison treats -0 and 0 as equal
const eqCheck = (zero === negZero);
print('zero === -zero:', eqCheck);

// Object.is distinguishes them
const isCheck = Object.is(zero, negZero);
print('Object.is(0, -0):', isCheck);

// Arithmetic behavior differs
const zeroRecip = 1 / zero;
const negZeroRecip = 1 / negZero;
print('1/0:', zeroRecip);
print('1/-0:', negZeroRecip);

// In arrays/objects
const arr = [zero, negZero];
print('array:', arr.join(','));

// Object.is can detect it
const z0 = Object.is(1 / zero, Infinity);
const z1 = Object.is(1 / negZero, -Infinity);
print('is-positive:', z0);
print('is-negative:', z1);
