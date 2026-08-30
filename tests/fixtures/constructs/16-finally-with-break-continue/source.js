// break/continue inside finally inside a loop (suppresses the pending exception).
const trace = [];
for (let i = 0; i < 5; i++) {
  try {
    if (i === 2) throw new Error('at ' + i);
    trace.push('ok:' + i);
  } finally {
    if (i === 2) {
      trace.push('finally-continue-suppresses-throw:' + i);
      continue;
    }
  }
  trace.push('after-try:' + i);
}
print(trace.join(' | '));

const trace2 = [];
for (let i = 0; i < 10; i++) {
  try {
    if (i === 3) throw new Error('stop');
    trace2.push('iter:' + i);
  } finally {
    if (i === 3) {
      trace2.push('finally-break-suppresses-throw');
      break;
    }
  }
}
print(trace2.join(' | '));
