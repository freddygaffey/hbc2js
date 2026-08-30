// try/finally with no catch; exception propagates through finally.
function risky() {
  try {
    print('entering try');
    throw new Error('propagated');
  } finally {
    print('finally always runs');
  }
}
try {
  risky();
} catch (e) {
  print('caught outside:', e.message);
}

function cleanup(log) {
  try {
    log.push('body');
  } finally {
    log.push('cleanup');
  }
  return log;
}
print(cleanup([]).join(','));
