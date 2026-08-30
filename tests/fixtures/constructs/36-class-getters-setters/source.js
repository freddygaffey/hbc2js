// get/set accessors on both a plain object literal and a class.
// NOTE: class accessors are only supported by v99 among the hermesc
// versions this project fetches (plain classes fail to compile on
// v84/v94 entirely) -- see versions.txt.
const temp = {
  _celsius: 0,
  get celsius() { return this._celsius; },
  set celsius(v) { this._celsius = v; },
  get fahrenheit() { return this._celsius * 9 / 5 + 32; },
  set fahrenheit(f) { this._celsius = (f - 32) * 5 / 9; }
};
temp.celsius = 100;
print('celsius=' + temp.celsius, 'fahrenheit=' + temp.fahrenheit);
temp.fahrenheit = 32;
print('after setting F=32, celsius=' + temp.celsius);

class Rectangle {
  constructor(w, h) {
    this._w = w;
    this._h = h;
  }
  get area() { return this._w * this._h; }
  get width() { return this._w; }
  set width(v) {
    if (v <= 0) throw new Error('invalid width');
    this._w = v;
  }
}
const r = new Rectangle(4, 5);
print('area=' + r.area);
r.width = 10;
print('new area=' + r.area);
try {
  r.width = -1;
} catch (e) {
  print('caught:', e.message);
}
