// Computed method and accessor names. At v99 hermesc lowers every one of these
// through `CallBuiltin HermesBuiltin.setFunctionName` (builtin 55) immediately
// before the `DefineOwnByVal` that installs the member -- the builtin whose
// number the generated hbc99 table used to give to `functionPrototypeApply`,
// which made the decompiled candidate emit `fn.apply(key, 0)` and throw
// (docs/BUGS.md, hardened-tier class divergences, 2026-09-05).
// The third argument selects the ES SetFunctionName prefix: 0 plain, 1 get, 2 set.
const key = 'run' + String(1);
const accessor = 'value';

class Widget {
  [key](n) {
    return n * 2;
  }

  get [accessor]() {
    return this._v;
  }

  set [accessor](v) {
    this._v = v * 10;
  }
}

const w = new Widget();
w.value = 2;
print('method:', w.run1(3), 'accessor:', w.value);
const d = Object.getOwnPropertyDescriptor(Widget.prototype, accessor);
print('descriptor:', typeof d.get, typeof d.set, d.enumerable, d.configurable);

const obj = {
  [key]() {
    return 'from object';
  },
};
print('object literal:', obj[key](), typeof obj[key]);
