// Object literals whose values are NOT all compile-time constants, so Hermes
// lowers them to `NewObject` + a run of own-property stores
// (`PutNewOwnById`/`PutOwnByIndex`/`PutOwnBySlotIdx`) rather than folding the
// whole thing into the object key/value buffer with `NewObjectWithBuffer`.
// docs/specs/passes/20-object-literal.md is the rung that rebuilds them.

// A -- plain data literal, computed values, keys in source order.
function point(x, y) {
  return { x: x + 1, y: y * 2, tag: 'p' + x };
}

// B -- literal with closure values (methods over a captured binding). This is
// the shape that dominates real bundles: `NewObject` then one
// `CreateClosure` + `PutNewOwnById` per method.
function makeCounter(start) {
  let n = start;
  return {
    name: 'counter',
    inc: function () { n += 1; return n; },
    read: function () { return n; },
  };
}

// C -- integer-like keys mixed with a named one; the numeric ones become
// indexed own properties, and the *enumeration* order is numeric-ascending
// first, which the rebuilt literal must not change.
function table(a, b) {
  return { 1: a + 1, 0: b + 1, 10: a * b, len: a + b };
}

// D -- NEGATIVE control: the half-built object is READ before the run ends,
// so the stores are not a literal and must stay separate assignments.
function selfRead(a) {
  const o = {};
  o.a = a + 1;
  o.b = o.a + 1;
  return o;
}

// E -- NEGATIVE control: an accessor property in the middle of the run. The
// prefix before it may fold; the accessor and everything after it may not.
function withGetter(v) {
  return {
    plain: v + 1,
    get doubled() { return v * 2; },
    after: v + 3,
  };
}

// F -- NEGATIVE control: the object escapes mid-run (passed to a function that
// can observe it), so later stores are not part of the literal.
function escapes(sink, v) {
  const o = {};
  o.first = v + 1;
  sink(o);
  o.second = v + 2;
  return o;
}

const p = point(2, 3);
print(p.x + ' ' + p.y + ' ' + p.tag);

const c = makeCounter(5);
print(c.name + ' ' + c.inc() + ' ' + c.inc() + ' ' + c.read());

const t = table(1, 2);
print(Object.keys(t).join(',') + ' ' + t[0] + ' ' + t[1] + ' ' + t[10] + ' ' + t.len);

const s = selfRead(7);
print(s.a + ' ' + s.b);

const g = withGetter(4);
print(g.plain + ' ' + g.doubled + ' ' + g.after);

let seen = 'none';
const e = escapes(function (o) { seen = 'first=' + o.first + ' second=' + o.second; }, 10);
print(seen + ' ' + e.first + ' ' + e.second);
