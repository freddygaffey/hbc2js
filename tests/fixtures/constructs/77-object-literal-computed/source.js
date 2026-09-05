// Computed-key own-property stores (`PutOwnByVal`/`DefineOwnByVal`) inside an
// object literal -- the residual (c) shape from
// docs/specs/passes/20-object-literal.md section 7: `{[k]: v, ...}` lowers to
// a fresh `NewObject` plus one own-define store per property (computed keys
// included), and this rung rebuilds the literal from them.
// tests/fixtures/constructs/63-object-literal covers the plain-key shapes
// this rung already handled; this fixture is only the computed-key ones.
// `PutOwnByVal`/`DefineOwnByVal` (unlike `PutNewOwnById`) is ONLY ever
// emitted for object-literal *syntax* -- every function below returns its
// object directly from a `{...}` literal, never builds it with `const o =
// {}` plus later assignment statements (those compile to a full `[[Set]]`
// `PutByVal`, a different opcode this rung does not touch).

// G -- POSITIVE: the key is a register/parameter, never a literal (`key` is
// read exactly once, at the property position, so there is nothing for
// `expr-rebuild` to inline -- it is just a bare register read there). The
// "computed key from a const [binding]" shape.
function fromParam(key, v) {
  return { [key]: v };
}

// H -- POSITIVE: the key is a call result. Hermes computes it into a
// temporary register immediately before the store; `expr-rebuild` inlines
// that single-use temporary into the store's key position (its own R1a/R1b
// adjacency rule), and this rung then folds the whole store -- key and
// value -- into the literal. The "computed key from a call result" shape.
function fromCall(v) {
  return { [computeKey()]: v };
}
function computeKey() {
  return "k" + 1;
}

// I -- POSITIVE: a plain key followed by a computed one. Both fold, in
// source order -- the "interleaved with a plain key" shape. (A computed key
// never blocks folding anything that came *before* it; only a plain key
// that comes *after* one is the aliasing hazard function J covers.)
function mixed(key, v) {
  return { a: v + 1, [key]: 100 };
}

// J -- NEGATIVE control: a plain key AFTER a computed one. The computed key
// might alias the plain key's name at runtime, and this rung cannot prove
// it does not, so folding both would risk the wrong write winning
// (docs/specs/passes/20-object-literal.md section 7's aliasing rule -- see
// its worked example). Only `[key]: ...` may fold into the literal; `b:
// ...` must stay a separate, trailing store.
function aliasRisk(key, v) {
  return { [key]: v + 1, b: v + 2 };
}

const g = fromParam("dyn", 11);
print(g.dyn + " " + Object.keys(g).join(","));

const h = fromCall(22);
print(h.k1 + " " + Object.keys(h).join(","));

const m = mixed("c", 33);
print(m.a + " " + m.c + " " + Object.keys(m).join(","));

const a1 = aliasRisk("b", 44); // aliases: both stores target "b"
print(a1.b + " " + Object.keys(a1).join(","));

const a2 = aliasRisk("z", 55); // no alias: two distinct properties
print(a2.z + " " + a2.b + " " + Object.keys(a2).join(","));
