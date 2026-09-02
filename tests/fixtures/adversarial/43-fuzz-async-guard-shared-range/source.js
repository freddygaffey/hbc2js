let inGuard = 0;
const seen = [];
function applyWithGuard(fun, ctx, args) {
  try {
    return fun.apply(ctx, args);
  } catch (e) {
    seen.push('reportError ' + e.message);
    return null;
  }
}
function boom() {
  throw new Error('boom');
}
try {
  print('guarded ok:', applyWithGuard(function (a, b) { return a + b; }, null, [0, 0]));
  print('guarded throw:', applyWithGuard(boom, null, []));
} catch (e) {
}
print('seen:', seen.join(' | '));
print('inGuard settled at:', inGuard);
async function guardedAwait(shouldThrow) {
  try {
    if (shouldThrow) throw new Error('async-boom');
    return 'async-ok';
  } catch (e) {
    return 'async-caught ' + e.message;
  } finally {
    seen.push('async-finally');
  }
}
guardedAwait(false).then(function (v) {
  print('await no-throw:', v);
  return guardedAwait(true);
}).then(function (v) {
  print('await throw:', v);
  print('final seen:', seen.join(' | '));
});