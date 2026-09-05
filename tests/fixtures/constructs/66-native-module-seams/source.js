// The JS half of the spec-27 L3 JS<->native seam join (docs/specs/
// 27-native-side.md L3, docs/specs/10-artifact-format.md 2.8): the four
// boundary shapes the join reads off the artifact index --
// `NativeModules.<Module>.<method>()` with a native impl, a
// `NativeModules.<Module>` with NO native impl in the APK (the `js-only`
// seam), `TurboModuleRegistry.get("X")` and `requireNativeComponent("Y")`.
//
// The host objects are declared here as ordinary top-level script `var`s /
// a function declaration so the fixture runs standalone under every VM and
// prints a deterministic trace; in a real bundle they come from the RN
// runtime. Either way the bytecode is the same shape the join reads: a
// global read of the anchor plus the member/literal strings.
var NativeModules = {
  Crypto: {
    generateKey: function (algo) {
      return 'key(' + algo + ')';
    },
  },
  Missing: {
    foo: function () {
      return 'missing-foo';
    },
  },
};
var TurboModuleRegistry = {
  get: function (name) {
    return { name: name };
  },
};
function requireNativeComponent(name) {
  return 'component(' + name + ')';
}
function useCrypto() {
  return NativeModules.Crypto.generateKey('aes-256');
}
function useMissing() {
  return NativeModules.Missing.foo();
}
function useTurbo() {
  return TurboModuleRegistry.get('X').name;
}
function useComponent() {
  return requireNativeComponent('Y');
}
print(useCrypto());
print(useMissing());
print(useTurbo());
print(useComponent());
