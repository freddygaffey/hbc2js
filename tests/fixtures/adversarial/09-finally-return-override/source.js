// Control flow: finally block with return overrides try's return

function test1() {
  try {
    return 'from-try';
  } finally {
    return 'from-finally';
  }
}

function test2() {
  try {
    throw new Error('error');
  } catch (e) {
    return 'from-catch';
  } finally {
    return 'from-finally-2';
  }
}

function test3() {
  try {
    return 'try-value';
  } finally {
    // no return, just side effect
  }
}

print('test1:', test1());
print('test2:', test2());
print('test3:', test3());
