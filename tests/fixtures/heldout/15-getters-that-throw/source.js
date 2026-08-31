// Accessor properties that throw, lazy self-replacing getters, setters with
// validation, and how JSON.stringify / spread / destructuring / `in` react.
var accessLog = [];
var model = {
  _balance: 100,
  get balance() {
    accessLog.push('get balance');
    if (this._locked) throw new Error('locked');
    return this._balance;
  },
  set balance(v) {
    accessLog.push('set balance ' + v);
    if (typeof v !== 'number' || v < 0) throw new RangeError('bad balance ' + v);
    this._balance = v;
  },
  get always() { throw new TypeError('never readable'); },
  plain: 'p',
};

print('balance=' + model.balance);
model.balance = 250;
print('after set: ' + model._balance);
try { model.balance = -5; } catch (e) { print('setter rejected: ' + e.name + ' ' + e.message + ' balance still ' + model._balance); }
try { model.balance = 'lots'; } catch (e) { print('setter rejected: ' + e.name); }

model._locked = true;
try { print('unreachable ' + model.balance); } catch (e) { print('getter threw ' + e.message); }
print('in: ' + ('balance' in model) + ' hasOwn: ' + Object.prototype.hasOwnProperty.call(model, 'always') + ' keys: ' + Object.keys(model).join(','));

try { JSON.stringify(model); } catch (e) { print('stringify threw ' + e.message); }
try { var copy = { ...model }; print('spread ' + Object.keys(copy).length); } catch (e) { print('spread threw ' + e.message); }
try { var { plain, always } = model; print('destructure ' + plain + always); } catch (e) { print('destructure threw ' + e.name); }
model._locked = false;
var { plain: p2, balance: b2 } = model;
print('destructure ok ' + p2 + ' ' + b2);
print('log: ' + accessLog.join(' | '));

// Lazy getter that replaces itself with a data property on first read.
var computeCount = 0;
var config = {
  get expensive() {
    computeCount++;
    var value = 'computed#' + computeCount;
    Object.defineProperty(this, 'expensive', { value: value, writable: false, enumerable: true, configurable: true });
    return value;
  },
};
print([config.expensive, config.expensive, config.expensive, computeCount].join(' '));
var descriptor = Object.getOwnPropertyDescriptor(config, 'expensive');
print('now data property: ' + ('value' in descriptor) + ' writable=' + descriptor.writable);
config.expensive = 'overwrite attempt';
print('sloppy write ignored: ' + config.expensive);

// Getters on prototypes and via defineProperty; `this` is the receiver.
function Temperature(c) { this.c = c; }
Object.defineProperty(Temperature.prototype, 'f', {
  get: function () { if (this.c === null) throw new Error('no reading'); return this.c * 9 / 5 + 32; },
  set: function (f) { this.c = (f - 32) * 5 / 9; },
  enumerable: false,
});
var t = new Temperature(100);
print('f=' + t.f + ' keys=' + Object.keys(t).join(','));
t.f = 32;
print('c=' + t.c);
var broken = new Temperature(null);
var readings = [t, broken, new Temperature(-40)].map(function (x) {
  try { return String(x.f); } catch (e) { return 'ERR(' + e.message + ')'; }
});
print(readings.join(','));

// A getter throwing inside a comparison / arithmetic expression aborts it midway.
var evalOrder = [];
var left = { get v() { evalOrder.push('L'); return 1; } };
var right = { get v() { evalOrder.push('R'); throw new Error('R failed'); } };
try { var sum = left.v + right.v + left.v; print('sum ' + sum); } catch (e) { print('aborted after ' + evalOrder.join('') + ': ' + e.message); }
try { var cmp = right.v < left.v; print('cmp ' + cmp); } catch (e) { print('aborted after ' + evalOrder.join('')); }
