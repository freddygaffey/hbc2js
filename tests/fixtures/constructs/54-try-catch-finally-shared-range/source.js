// A `try` with BOTH a catch and a finally compiles to two exception-handler
// table entries whose byte ranges are IDENTICAL. The Hermes VM picks the FIRST
// matching entry, so the catch (emitted first) wins and the finally's
// catch-and-rethrow half is the outer one. React Native's own ErrorUtils
// `applyWithGuard` is exactly this shape, so every RN app routes errors
// through it.
let inGuard = 0;
const seen = [];

function applyWithGuard(fun, ctx, args) {
  try {
    inGuard++;
    return fun.apply(ctx, args);
  } catch (e) {
    seen.push('reportError ' + e.message);
    return null;
  } finally {
    inGuard--;
  }
}

function boom() {
  throw new Error('boom');
}

try {
  print('guarded ok:', applyWithGuard(function (a, b) { return a + b; }, null, [2, 3]));
  print('guarded throw:', applyWithGuard(boom, null, []));
} catch (e) {
  seen.push('escaped ' + e.message);
}
print('seen:', seen.join(' | '));
print('inGuard settled at:', inGuard);

// The same shape around an `await`: at v84/v94 the async lowering also emits
// two identical-range handlers.
async function guardedAwait(shouldThrow) {
  try {
    await Promise.resolve(1);
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

// A nested try/catch/finally inside a catch, so the equal-range pairs nest.
function nested() {
  try {
    try {
      throw new Error('inner');
    } catch (e) {
      throw new Error('rethrown ' + e.message);
    } finally {
      seen.push('inner-finally');
    }
  } catch (e) {
    return 'outer caught ' + e.message;
  } finally {
    seen.push('outer-finally');
  }
}
print('nested:', nested());
