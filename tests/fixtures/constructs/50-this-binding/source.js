// this in a plain function, arrow function, method, and via call/apply/bind.
function plainFn() {
  return typeof this;
}
print('plain function this (non-strict, global-ish):', plainFn());

const obj = {
  value: 42,
  getValue: function () { return this.value; },
  getValueArrow: () => { return typeof this; },
  makeArrowGetter: function () {
    return () => this.value;
  }
};
print('method this:', obj.getValue());
print('arrow at object-literal position ignores obj:', obj.getValueArrow());
print('arrow defined inside method captures method this:', obj.makeArrowGetter()());

function standalone() {
  return this && this.value;
}
print('call:', standalone.call({ value: 'via-call' }));
print('apply:', standalone.apply({ value: 'via-apply' }));
const bound = standalone.bind({ value: 'via-bind' });
print('bind:', bound());

function Counter() {
  this.count = 0;
  this.increment = function () { this.count++; return this.count; };
}
const c1 = new Counter();
const detached = c1.increment;
print('detached loses this:', (function () { try { return detached(); } catch (e) { return 'threw:' + e.constructor.name; } })());
print('bound retains this:', detached.bind(c1)());
