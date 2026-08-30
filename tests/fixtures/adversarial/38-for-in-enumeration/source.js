// Control flow: for-in enumeration order (array vs object)

// for-in order for objects is insertion order (in modern JS)
const obj = { z: 1, a: 2, m: 3 };
let keys = [];
for (const k in obj) {
  keys.push(k);
}
print('object keys:', keys.join(','));

// for-in on array enumerates indices
const arr = ['a', 'b', 'c'];
let indices = [];
for (const i in arr) {
  indices.push(i);
}
print('array indices:', indices.join(','));

// for-in with sparse array
const sparse = [10, , 30];
let sparseKeys = [];
for (const k in sparse) {
  sparseKeys.push(k);
}
print('sparse keys:', sparseKeys.join(','));

// for-in doesn't enumerate inherited properties (unless enumerable)
const parent = { inherited: 'yes' };
const child = Object.create(parent);
child.own = 'yes';
let childKeys = [];
for (const k in child) {
  childKeys.push(k);
}
print('child keys:', childKeys.join(','));
