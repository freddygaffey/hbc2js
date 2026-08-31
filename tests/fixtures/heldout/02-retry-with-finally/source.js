// A retry helper as found in network layers: try/catch/finally with rethrow,
// return-in-finally overriding, nested handlers and a custom error type.
function NetworkError(message, code) {
  this.name = 'NetworkError';
  this.message = message;
  this.code = code;
}
NetworkError.prototype = Object.create(Error.prototype);
NetworkError.prototype.constructor = NetworkError;

var log = [];
function attempt(n) {
  log.push('attempt ' + n);
  if (n < 3) throw new NetworkError('flaky ' + n, 500 + n);
  if (n === 4) throw new TypeError('bad payload');
  return 'ok@' + n;
}

function withRetry(max) {
  var lastError = null;
  for (var i = 1; i <= max; i++) {
    try {
      var value = attempt(i);
      log.push('success');
      return value;
    } catch (e) {
      lastError = e;
      if (!(e instanceof NetworkError)) {
        log.push('non-retryable ' + e.name);
        throw e;
      }
      log.push('retry after ' + e.code);
    } finally {
      log.push('cleanup ' + i);
    }
  }
  throw lastError;
}

print(withRetry(5));
print(log.join(' ; '));

log = [];
try {
  withRetry(2);
} catch (e) {
  print('outer caught ' + e.name + ': ' + e.message + ' (code ' + e.code + ')');
}
print(log.join(' ; '));

function overriding() {
  try {
    throw new Error('lost');
  } finally {
    return 'finally wins';
  }
}
print(overriding());

function nestedFinally() {
  var trail = [];
  try {
    try {
      trail.push('inner try');
      throw new RangeError('deep');
    } finally {
      trail.push('inner finally');
    }
  } catch (e) {
    trail.push('caught ' + (e instanceof RangeError ? 'RangeError' : 'other'));
    try {
      return trail.concat('early return').join(',');
    } finally {
      trail.push('after return');
    }
  } finally {
    trail.push('outer finally');
  }
  return 'unreachable';
}
print(nestedFinally());

// attempt(4) throws a TypeError once the network errors are exhausted.
log = [];
try {
  print(withRetry(4));
} catch (e) {
  print('got ' + e.name + ' after ' + log.length + ' log lines');
}
