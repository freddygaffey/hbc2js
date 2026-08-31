// Module-pattern event emitter (IIFE with private state), listeners as
// closures, `once` wrappers, unsubscribe during dispatch, and closures
// created in loops — the `var` + IIFE capture idiom transpilers emit.
var Emitter = (function () {
  var listeners = {};
  var dispatchDepth = 0;

  function on(name, fn) {
    (listeners[name] || (listeners[name] = [])).push(fn);
    return function off() {
      var list = listeners[name] || [];
      var idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
      return idx >= 0;
    };
  }

  function once(name, fn) {
    var off = on(name, function wrapper() {
      off();
      return fn.apply(this, arguments);
    });
    return off;
  }

  function emit(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    var list = (listeners[name] || []).slice();
    dispatchDepth++;
    var results = [];
    for (var i = 0; i < list.length; i++) {
      results.push(list[i].apply({ event: name, depth: dispatchDepth }, args));
    }
    dispatchDepth--;
    return results;
  }

  function count(name) {
    return (listeners[name] || []).length;
  }

  return { on: on, once: once, emit: emit, count: count };
})();

var trace = [];
var offA = Emitter.on('tick', function (n) { trace.push('A' + n); return 'a' + n; });
Emitter.once('tick', function (n) { trace.push('B' + n + '@' + this.depth); return 'b'; });
Emitter.on('tick', function (n) {
  if (n === 2) {
    trace.push('A removed=' + offA());
  }
  return 'c' + this.event;
});

print(Emitter.emit('tick', 1).join(','));
print(Emitter.emit('tick', 2).join(','));
print(Emitter.emit('tick', 3).join(','));
print('trace ' + trace.join(' '));
print('count=' + Emitter.count('tick') + ' none=' + Emitter.count('nope'));
print('emit nothing: [' + Emitter.emit('nope').join(',') + ']');

// Closures made in a loop: the classic var bug versus the IIFE fix.
var buggy = [];
for (var i = 0; i < 3; i++) buggy.push(function () { return i; });
var fixed = [];
for (var j = 0; j < 3; j++) {
  (function (k) { fixed.push(function () { return k * 10; }); })(j);
}
var viaForEach = [];
['x', 'y', 'z'].forEach(function (ch, idx) { viaForEach.push(function () { return ch + idx; }); });
print(buggy.map(function (f) { return f(); }).join(','));
print(fixed.map(function (f) { return f(); }).join(','));
print(viaForEach.map(function (f) { return f(); }).join(','));

// Nested emit: a handler that re-emits another event sees a deeper depth.
Emitter.on('outer', function () { return 'outer@' + this.depth + '>' + Emitter.emit('inner').join(''); });
Emitter.on('inner', function () { return 'inner@' + this.depth; });
print(Emitter.emit('outer').join(','));
