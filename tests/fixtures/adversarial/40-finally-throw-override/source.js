// Control flow: finally block with throw overrides try error

function test1() {
  try {
    throw new Error('original');
  } finally {
    throw new Error('from-finally');
  }
}

function test2() {
  try {
    throw new Error('try-error');
  } catch (e) {
    throw new Error('from-catch');
  } finally {
    throw new Error('from-finally-2');
  }
}

function test3() {
  try {
    throw new Error('try');
  } finally {
    // No error in finally, original propagates
  }
}

let trace = [];

try {
  test1();
} catch (e) {
  trace.push('test1:' + e.message);
}

try {
  test2();
} catch (e) {
  trace.push('test2:' + e.message);
}

try {
  test3();
} catch (e) {
  trace.push('test3:' + e.message);
}

print('results:', trace.join('|'));
