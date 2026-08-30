// Nested try/catch with rethrow and outer catch inspecting error chaining.
function level3() {
  throw new Error('level3-failure');
}
function level2() {
  try {
    level3();
  } catch (innerErr) {
    const wrapped = new Error('level2-wrapped');
    wrapped.cause = innerErr;
    throw wrapped;
  }
}
function level1() {
  try {
    level2();
  } catch (outerErr) {
    let chain = [outerErr.message];
    let cur = outerErr.cause;
    while (cur) {
      chain.push(cur.message);
      cur = cur.cause;
    }
    return chain.join(' <- caused by <- ');
  }
}
print(level1());

try {
  try {
    throw new TypeError('inner-type-error');
  } catch (e) {
    if (e instanceof TypeError) {
      throw new RangeError('rethrown-as-range: ' + e.message);
    }
  }
} catch (e2) {
  print(e2.constructor.name + ':', e2.message);
}
