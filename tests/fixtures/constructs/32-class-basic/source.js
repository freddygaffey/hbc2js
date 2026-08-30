// class with constructor, instance fields, and instance methods.
// NOTE: public instance field syntax (`x = 1;`) is only supported by v99
// among the hermesc versions this project fetches -- see versions.txt.
class Point {
  x = 0;
  y = 0;
  label = 'point';

  constructor(x, y) {
    this.x = x;
    this.y = y;
  }

  distanceFromOrigin() {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  toString() {
    return this.label + '(' + this.x + ',' + this.y + ')';
  }

  translate(dx, dy) {
    this.x += dx;
    this.y += dy;
    return this;
  }
}
const p1 = new Point(3, 4);
print(p1.toString(), 'dist=' + p1.distanceFromOrigin());
p1.translate(1, 1);
print('after translate:', p1.toString());

const p2 = new Point();
print('defaulted fields:', p2.toString());
