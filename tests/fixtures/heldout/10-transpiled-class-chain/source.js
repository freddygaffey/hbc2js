// Babel/Metro-style transpiled classes: prototype chains built by helper
// functions, `this` threaded through call/apply/bind, `new` on functions,
// and instanceof across the chain — what Hermes actually sees for ES2015
// classes in a React Native bundle.
function _inherits(sub, sup) {
  sub.prototype = Object.create(sup.prototype, { constructor: { value: sub, writable: true, configurable: true } });
  Object.setPrototypeOf(sub, sup);
}
function _createClass(ctor, protoProps, staticProps) {
  var define = function (target, props) {
    for (var i = 0; i < props.length; i++) {
      var p = props[i];
      Object.defineProperty(target, p.key, { value: p.value, enumerable: false, configurable: true, writable: true });
    }
  };
  if (protoProps) define(ctor.prototype, protoProps);
  if (staticProps) define(ctor, staticProps);
  return ctor;
}

var Component = (function () {
  function Component(props) {
    if (!(this instanceof Component)) throw new TypeError('call with new');
    this.props = props || {};
    this.state = { renders: 0 };
    this.handleChange = this.handleChange.bind(this);
  }
  _createClass(Component, [
    { key: 'setState', value: function (patch) {
      var prev = this.state;
      this.state = Object.assign({}, prev, typeof patch === 'function' ? patch.call(this, prev) : patch);
      return this.state;
    } },
    { key: 'handleChange', value: function (value) { return this.setState({ value: value, renders: this.state.renders + 1 }); } },
    { key: 'render', value: function () { return '<' + this.displayName() + ' value=' + this.state.value + '>'; } },
    { key: 'displayName', value: function () { return 'Component'; } },
  ], [
    { key: 'of', value: function (props) { return new this(props); } },
  ]);
  return Component;
})();

var Input = (function (_Component) {
  _inherits(Input, _Component);
  function Input(props) {
    var _this = _Component.call(this, props) || this;
    _this.state.value = props.initial;
    return _this;
  }
  _createClass(Input, [
    { key: 'displayName', value: function () { return 'Input(' + _Component.prototype.displayName.call(this) + ')'; } },
    { key: 'clear', value: function () { return this.handleChange(''); } },
  ]);
  return Input;
})(Component);

var input = Input.of({ initial: 'hi' });
print(input.render());
var detached = input.handleChange;
detached('typed');
print(input.render() + ' renders=' + input.state.renders);
input.setState(function (prev) { return { value: prev.value + '!' }; });
print(input.render());
print(JSON.stringify(input.clear()));
print([input instanceof Input, input instanceof Component, Component.of === Input.of, Object.keys(input).join('/')].join(' '));
try {
  Component({});
} catch (e) {
  print('plain call: ' + e.name + ' ' + e.message);
}

// call / apply / bind semantics used by the helper layer.
function whoami(prefix, suffix) {
  return prefix + (this && this.tag !== undefined ? this.tag : typeof this) + (suffix || '');
}
var tagged = { tag: 'T' };
print(whoami.call(tagged, '[', ']') + ' ' + whoami.apply(tagged, ['(', ')']) + ' ' + whoami.apply(null, ['{']));
var bound = whoami.bind(tagged, '<');
var rebound = bound.bind({ tag: 'ignored' }, '>');
print(bound('>') + ' ' + rebound() + ' ' + bound.length + ' ' + rebound.length);
function Point(x, y) { this.x = x; this.y = y; }
var BoundPoint = Point.bind({ tag: 'ignored for new' }, 1);
var pt = new BoundPoint(2);
print(pt.x + ',' + pt.y + ' ' + (pt instanceof Point) + ' ' + (pt instanceof BoundPoint));
var arrowThis = { tag: 'lexical', get: function () { return [1, 2].map(function () { return this.tag; }, this).concat([1].map(() => this.tag)); } };
print(arrowThis.get().join(','));
