// Interleaved Promise.resolve().then() ordering (no queueMicrotask/setTimeout,
// which are host APIs, not guaranteed in bare Hermes -- see project convention).
const log = [];
log.push('sync-1');
Promise.resolve().then(function () { log.push('microtask-A1'); }).then(function () { log.push('microtask-A2'); });
Promise.resolve().then(function () { log.push('microtask-B1'); });
log.push('sync-2');

async function asyncFn() {
  log.push('async-fn-start');
  await null;
  log.push('async-fn-after-await');
}
asyncFn();
log.push('sync-3');

Promise.resolve()
  .then(function () { log.push('microtask-C1'); return Promise.resolve(); })
  .then(function () { log.push('microtask-C2 (chained promise flattens)'); });

Promise.resolve().then(function () {
  log.push('final-tick');
  print(log.join(' -> '));
});
