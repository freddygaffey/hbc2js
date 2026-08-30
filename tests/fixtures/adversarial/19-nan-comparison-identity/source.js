// Values: NaN comparisons and identity

const nan = NaN;
const computedNan = 0 / 0;

// NaN !== NaN
const neq = (nan !== nan);
print('NaN !== NaN:', neq);

// Object.is(NaN, NaN) is true
const isEqual = Object.is(nan, computedNan);
print('Object.is(NaN, NaN):', isEqual);

// NaN in arrays is still NaN
const arr = [1, NaN, 3];
const isNan1 = Number.isNaN(arr[1]);
print('isNaN(arr[1]):', isNan1);

// Comparisons with NaN
const cmp1 = (nan > 5);
const cmp2 = (nan < 5);
const cmp3 = (nan === nan);
print('NaN > 5:', cmp1);
print('NaN < 5:', cmp2);
print('NaN === NaN:', cmp3);

// indexOf with NaN doesn't work the usual way
const idx = arr.indexOf(NaN);
print('indexOf(NaN):', idx);
