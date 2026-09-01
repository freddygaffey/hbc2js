// jsx-recover (docs/specs/passes/08-jsx-recovery.md, catalogue row R6). The
// two React element-creation runtimes, as stubs: the automatic runtime's
// jsx()/jsxs() (children in the config object, key as the third argument)
// and the classic React.createElement(type, props, ...children). The pass is
// opt-in (--jsx) and readability-only: with it off this file is plain JS and
// the harness runs it; with it on the same calls print as JSX. The stubs
// render a string so expected.txt pins the evaluation order and arity.
function render(type, props, key) {
  const name = typeof type === "string" ? type : type.displayName;
  const keys = Object.keys(props || {}).filter((k) => k !== "children");
  const kids = props && props.children;
  const inner = Array.isArray(kids) ? kids.join("") : kids === undefined ? "" : String(kids);
  return "<" + name + (key !== undefined ? " key=" + key : "") + (keys.length ? " " + keys.join(",") : "") + ">" + inner + "</" + name + ">";
}
const runtime = { jsx: render, jsxs: render };
const React = {
  createElement: function (type, props) {
    const kids = Array.prototype.slice.call(arguments, 2);
    return render(type, Object.assign({}, props, { children: kids }));
  },
  Fragment: { displayName: "Fragment" },
};
const Text = { displayName: "Text" };
const View = { displayName: "View" };
const Row = { displayName: "Row" };
const Ns = { Comp: { displayName: "Ns.Comp" } };

function screen(description, style, items) {
  const jsx = runtime.jsx;
  const jsxs = runtime.jsxs;
  const title = jsx(Text, { style: style, children: "hello" });
  const desc = jsx(Text, { style: style, children: description });
  const list = jsxs(View, { style: style, children: [title, desc] });
  const keyed = jsx(Text, { children: description }, "k1");
  const nested = jsxs(View, { children: [jsx(Text, { children: "a" }), jsx(Ns.Comp, {})] });
  const mapped = jsxs(View, {
    children: items.map(function (it) {
      return jsx(Text, { children: it }, it);
    }),
  });
  const dom = "div";
  const intrinsic = jsx(dom, { className: "x", children: description });
  const empty = jsx(View, {});
  return [title, desc, list, keyed, nested, mapped, intrinsic, empty];
}

function classic(item, child) {
  const a = React.createElement(Row, { item: item }, child);
  const b = React.createElement(React.Fragment, null, a, child);
  const c = React.createElement(View, { key: "z", style: item });
  return [a, b, c];
}

for (const s of screen("d", "s", ["x", "y"])) print(s);
for (const s of classic("i", "c")) print(s);
