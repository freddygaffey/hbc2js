// typeof on undeclared bindings, instanceof across the prototype chain, in.
print('typeof undeclared:', typeof neverDeclared);
print('typeof undefined var:', typeof (void 0));
let laterDeclared;
print('typeof let before assignment (declared, not TDZ here):', typeof laterDeclared);

function Base() {}
function Mid() {}
Mid.prototype = Object.create(Base.prototype);
function Leaf() {}
Leaf.prototype = Object.create(Mid.prototype);
const obj = new Leaf();
print('instanceof chain:', obj instanceof Leaf, obj instanceof Mid, obj instanceof Base, obj instanceof Array);

const container = { a: 1, b: undefined };
print('in checks:', 'a' in container, 'b' in container, 'c' in container);
print('array index in:', 0 in [10, 20], 5 in [10, 20]);

print('typeof primitives:', typeof 1, typeof 'x', typeof true, typeof null, typeof undefined, typeof {}, typeof [], typeof function () {}, typeof Symbol());
