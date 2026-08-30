// try/catch around a rejecting await, plus an unhandled rejection path.
function fail(msg) {
  return Promise.reject(new Error(msg));
}
async function guarded() {
  try {
    await fail('boom-1');
    print('unreachable');
  } catch (e) {
    print('guarded caught:', e.message);
  }
  return 'recovered';
}
guarded().then(function (v) { print('guarded resolved:', v); });

async function unguarded() {
  await fail('boom-2');
  return 'unreachable';
}
unguarded().then(
  function () { print('unreachable-then'); },
  function (e) { print('unguarded rejected via .then handler:', e.message); }
);
