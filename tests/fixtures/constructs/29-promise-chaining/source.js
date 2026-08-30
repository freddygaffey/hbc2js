// Equivalent .then/.catch chain vs. async/await, same observable order.
function step(n) {
  return Promise.resolve(n * 2);
}
function chainStyle() {
  const log = [];
  return step(1)
    .then(function (a) { log.push('a=' + a); return step(a); })
    .then(function (b) { log.push('b=' + b); if (b > 100) throw new Error('too big'); return step(b); })
    .then(function (c) { log.push('c=' + c); return log; })
    .catch(function (e) { log.push('caught:' + e.message); return log; });
}
async function asyncStyle() {
  const log = [];
  try {
    const a = await step(1);
    log.push('a=' + a);
    const b = await step(a);
    log.push('b=' + b);
    if (b > 100) throw new Error('too big');
    const c = await step(b);
    log.push('c=' + c);
  } catch (e) {
    log.push('caught:' + e.message);
  }
  return log;
}
chainStyle().then(function (log) { print('chain:', log.join(',')); });
asyncStyle().then(function (log) { print('async:', log.join(',')); });
