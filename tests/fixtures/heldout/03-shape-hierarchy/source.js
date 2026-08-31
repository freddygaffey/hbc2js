// Classes with inheritance, super calls, getters/setters, statics and a
// registry keyed by constructor — the kind of model layer a small app has.
class Shape {
  constructor(name) {
    this.name = name;
    Shape.count++;
  }
  get area() { return 0; }
  get label() { return this.name + '[' + this.area.toFixed(2) + ']'; }
  describe() { return 'shape ' + this.label; }
  static create(kind, ...args) {
    const ctor = Shape.registry[kind];
    if (!ctor) throw new Error('unknown kind ' + kind);
    return new ctor(...args);
  }
  static register(kind, ctor) { Shape.registry[kind] = ctor; return ctor; }
}
Shape.count = 0;
Shape.registry = {};

class Rect extends Shape {
  constructor(w, h) {
    super('rect');
    this.w = w;
    this.h = h;
  }
  get area() { return this.w * this.h; }
  set width(v) { if (v <= 0) throw new RangeError('width'); this.w = v; }
  describe() { return super.describe() + ' ' + this.w + 'x' + this.h; }
}
class Square extends Rect {
  constructor(s) { super(s, s); this.name = 'square'; }
  describe() { return 'a ' + super.describe(); }
  static create(s) { return new Square(s); }
}
class Circle extends Shape {
  constructor(r) { super('circle'); this.r = r; }
  get area() { return 3 * this.r * this.r; }
}
Shape.register('rect', Rect);
Shape.register('square', Square);
Shape.register('circle', Circle);

const shapes = [Shape.create('rect', 2, 3), Shape.create('square', 4), Shape.create('circle', 1), Square.create(2)];
for (const s of shapes) print(s.describe());
print('count=' + Shape.count);

const sq = shapes[1];
sq.width = 5;
print(sq.describe() + ' area=' + sq.area);
try {
  sq.width = -1;
} catch (e) {
  print('setter threw ' + e.name + ' ' + e.message + '; w still ' + sq.w);
}
try {
  Shape.create('hexagon');
} catch (e) {
  print(e.message);
}

print([sq instanceof Square, sq instanceof Rect, sq instanceof Shape, sq instanceof Circle].join(','));
print(Object.getPrototypeOf(Square) === Rect ? 'static chain ok' : 'static chain broken');
print(typeof Square.register + ' ' + (Square.register === Shape.register));
print(shapes.map((s) => s.constructor === Shape.registry[s.name] ? 'y' : 'n').join(''));

const sorted = shapes.slice().sort((a, b) => a.area - b.area || a.name.length - b.name.length);
print(sorted.map((s) => s.label).join(' < '));
