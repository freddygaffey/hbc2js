// `arguments` as legacy utility code uses it: length checks, slicing,
// forwarding via apply, lexical `arguments` inside arrows, interaction with
// default parameters and rest. Never written to (no sloppy aliasing).
function log() {
  var parts = [];
  for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
  return '[' + parts.join(' ') + ']';
}

function overload(a, b) {
  switch (arguments.length) {
    case 0: return 'none';
    case 1: return typeof a === 'object' && a !== null ? 'options:' + Object.keys(a).join('+') : 'single:' + a;
    case 2: return 'pair:' + a + ',' + b;
    default: return 'many:' + Array.prototype.slice.call(arguments, 2).join('/');
  }
}
print([overload(), overload(1), overload({ x: 1, y: 2 }), overload(1, 2), overload(1, 2, 3, 4), overload(undefined)].join(' '));

function forward() {
  return log.apply(null, arguments) + ' via apply, first=' + arguments[0] + ' last=' + arguments[arguments.length - 1];
}
print(forward('a', 2, null, undefined, true));
print(forward());

function withDefaults(a, b = a * 2, c) {
  return 'a=' + a + ' b=' + b + ' c=' + c + ' argc=' + arguments.length + ' fnlen=' + withDefaults.length;
}
print(withDefaults(1));
print(withDefaults(1, undefined, 3));
print(withDefaults(1, 5));

function withRest(first, ...rest) {
  var inner = function () { return arguments.length; };
  var arrow = () => arguments.length + ':' + arguments[0];
  return 'first=' + first + ' rest=' + rest.join(',') + ' argc=' + arguments.length + ' inner=' + inner('x') + ' arrow=' + arrow('ignored');
}
print(withRest('f', 1, 2, 3));
print(withRest());

function curry(fn) {
  var expected = fn.length;
  function collect(sofar) {
    return function () {
      var all = sofar.concat(Array.prototype.slice.call(arguments));
      return all.length >= expected ? fn.apply(this, all) : collect(all);
    };
  }
  return collect([]);
}
var add3 = curry(function (a, b, c) { return a + b + c; });
print([add3(1)(2)(3), add3(1, 2)(3), add3(1)(2, 3), add3(1, 2, 3), add3()(1)()(2)(3)].join(','));

function memoize(fn) {
  var cache = {};
  var hits = 0;
  var wrapped = function () {
    var key = JSON.stringify(Array.prototype.slice.call(arguments));
    if (key in cache) { hits++; return cache[key]; }
    return (cache[key] = fn.apply(this, arguments));
  };
  wrapped.hits = function () { return hits; };
  return wrapped;
}
var slowConcat = memoize(function (a, b) { return String(a) + String(b); });
print([slowConcat(1, 2), slowConcat('1', 2), slowConcat(1, 2), slowConcat(1, '2'), slowConcat(1, 2)].join(' ') + ' hits=' + slowConcat.hits());

function iterateArgs() {
  var out = [];
  for (var k in arguments) out.push(k);
  var viaFrom = Array.from(arguments).reverse().join('');
  var spread = [...arguments].length;
  return out.join(',') + ' ' + viaFrom + ' ' + spread + ' ' + Object.prototype.toString.call(arguments) + ' ' + Array.isArray(arguments);
}
print(iterateArgs('a', 'b', 'c'));
print((function () { return arguments.length + ' ' + typeof arguments + ' ' + (arguments instanceof Object) + ' ' + JSON.stringify(arguments); })(1, 'two', [3]));
