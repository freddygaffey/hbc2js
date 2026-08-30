// this/hoisting: method extracted and called without context

const obj = {
  value: 42,
  getValue() {
    return this.value;
  }
};

// Call normally - this is bound to obj
const r1 = obj.getValue();

// Extract and call - this is undefined in strict mode or globalThis in sloppy
const extracted = obj.getValue;
let r2;
try {
  r2 = extracted();  // In non-strict, this would be globalThis
  // Check if we got the value from globalThis.value (undefined)
  r2 = r2 === undefined ? 'undefined-value' : r2;
} catch (e) {
  r2 = 'error:' + e.constructor.name;
}

// Using call to set this explicitly
const r3 = extracted.call(obj);

print('normal call:', r1);
print('extracted:', r2);
print('explicit this:', r3);
