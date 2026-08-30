// Default parameters referencing earlier parameters, evaluated lazily per-call.
function greet(name, greeting = 'Hello, ' + name + '!') {
  return greeting;
}
print(greet('Ada'));
print(greet('Bo', 'Hi Bo'));

let sideEffectCount = 0;
function withSideEffectDefault(x = (sideEffectCount++, 'default-' + sideEffectCount)) {
  return x;
}
print(withSideEffectDefault());
print(withSideEffectDefault());
print(withSideEffectDefault('explicit'));
print('side effect only ran for defaulted calls:', sideEffectCount);

function chainedDefaults(a = 1, b = a + 1, c = a + b) {
  return a + ',' + b + ',' + c;
}
print(chainedDefaults());
print(chainedDefaults(10));
print(chainedDefaults(10, 20));
print(chainedDefaults(10, 20, 30));

function defaultUsesFunction(n, doubled = (function (v) { return v * 2; })(n)) {
  return doubled;
}
print(defaultUsesFunction(7));
