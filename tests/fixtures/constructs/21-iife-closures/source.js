// IIFE module pattern exposing a closure-private counter.
const counterModule = (function () {
  let count = 0;
  return {
    increment: function () { return ++count; },
    decrement: function () { return --count; },
    reset: function () { count = 0; return count; },
    value: function () { return count; }
  };
})();

print('initial:', counterModule.value());
print('inc:', counterModule.increment());
print('inc:', counterModule.increment());
print('inc:', counterModule.increment());
print('dec:', counterModule.decrement());
print('reset:', counterModule.reset());
print('final value:', counterModule.value());

const named = (function selfRef(n) {
  return n <= 1 ? 1 : n * selfRef(n - 1);
})(5);
print('named IIFE factorial(5)=' + named);
