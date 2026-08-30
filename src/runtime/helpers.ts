// docs/specs/05-emitter.md §7 -- the runtime helper prelude.
//
// Every helper here implements a Hermes VM primitive that has no direct JS
// surface form: the generator resume protocol, `arguments` reification, the
// iteration opcodes (`IteratorBegin`/`IteratorNext`/`IteratorClose`,
// `GetPNameList`/`GetNextPName`), and the *internal* entries of the
// `CallBuiltin` table (`arraySpread`, `copyDataProperties`, `spawnAsync`, ...)
// which are runtime intrinsics, not JS globals. "It would be repetitive
// otherwise" is never a reason: property access, arithmetic, comparisons,
// `typeof`, `instanceof`, literals, `throw` and `try` all lower inline.
//
// Builtins that *are* real JS globals (`Math.floor`, `JSON.stringify`,
// `Object.keys`, `Array.isArray`, `String.fromCharCode`, `globalThis.Symbol`, ...)
// get no helper at all -- src/emit/calls.ts emits the call directly.
//
// Each helper is emitted only when used (`helpersUsed`, EM-03), in dependency
// order, and the set is byte-stable.

export interface Helper {
  readonly name: string;
  readonly deps: readonly string[];
  readonly source: string;
}

function h(name: string, source: string, deps: readonly string[] = []): [string, Helper] {
  return [name, { name, deps, source: source.trim() }];
}

export const HELPERS: Readonly<Record<string, Helper>> = Object.fromEntries([
  // The VM's "empty" sentinel: the value a TDZ binding holds before its
  // initialiser runs, written by `LoadConstEmpty` and tested by `ThrowIfEmpty`
  // and `ThrowIfThisInitialized`. It has no JS surface form -- collapsing it to
  // `undefined` would silently disarm every TDZ check the bytecode does have,
  // which §8 forbids just as firmly as inventing one it does not.
  h("__hbc_empty", `var __hbc_empty = Symbol("empty");`),

  // The Hermes host object the compiler calls into. Only the entry points real
  // bytecode reaches are provided, each matching the observed calling
  // convention: `concat` is invoked with the first string as `this` and the
  // remaining pieces as arguments (43-template-literals v94,
  // `Call3 r5, r6, r5, r3, r2`).
  h(
    "__hbc_HermesInternal",
    `
var __hbc_HermesInternal = {
  concat: function () {
    // ToString on every piece, not ToPrimitive: Hermes renders an object
    // argument as "[object Object]" even when it has a valueOf. A Symbol still
    // has to throw, which String() would not do, so it goes through unary plus.
    var str = function (v) { return typeof v === "symbol" ? "" + v : String(v); };
    var s = str(this);
    for (var i = 0; i < arguments.length; i++) s += str(arguments[i]);
    return s;
  },
  getEpilogues: function () { return []; },
  hasPromise: function () { return true; },
  useEngineQueue: function () { return false; },
  enqueueJob: function (job) { Promise.resolve().then(job); }
};
`,
  ),

  // `yield*` at v<=96: the body computes the *inner* iterator's result object
  // and marks the generator delegated, and the VM then passes that object
  // through as the outer generator's own result instead of wrapping the value
  // again (25-generator-delegation). The flag is module-scoped because
  // `CallBuiltin generatorSetDelegated` names no generator: it always means
  // "the one currently stepping".
  h("__hbc_delegated", `var __hbc_delegated = false;`),

  // -------------------------------------------------------------------------
  // §7.2.1 — v<=96 generator protocol.
  //
  // The body is emitted as a *frame factory*: calling it allocates one
  // generator instance's registers and environment slots and returns a `step`
  // function. That is what makes `SaveGenerator`/`ResumeGenerator` expressible
  // at all -- the VM saves and restores the whole register frame across a
  // suspend, so the frame has to outlive a single call.
  //
  //   step(sent, isReturn, isThrow) -> [value, done]
  //
  // `isThrow` has no counterpart in `ResumeGenerator`'s operands because the VM
  // implements `.throw()` by raising at the saved pc; the emitter reproduces
  // that by following every `ResumeGenerator` with `if (isThrow) throw sent;`,
  // so the exception unwinds through the body's own handlers exactly as it does
  // under Hermes.
  // -------------------------------------------------------------------------
  h(
    "__hbc_makeGenerator",
    `
function __hbc_makeGenerator(factory, thisArg, args) {
  var step = Reflect.apply(factory, thisArg, args);
  var finished = false;
  var running = false;
  function resume(sent, isReturn, isThrow) {
    if (running) throw new TypeError("Generator functions may not be called on executing generators");
    if (finished) {
      if (isThrow) throw sent;
      return { value: isReturn ? sent : undefined, done: true };
    }
    running = true;
    __hbc_delegated = false;
    var r;
    try {
      r = step(sent, isReturn, isThrow);
    } catch (e) {
      finished = true;
      running = false;
      throw e;
    }
    running = false;
    if (r[1]) {
      finished = true;
      return { value: r[0], done: true };
    }
    // Delegated (yield-star): the body already produced the inner iterator's
    // result object, which is passed through unwrapped.
    if (__hbc_delegated) return r[0];
    return { value: r[0], done: false };
  }
  // The protocol methods go on a per-instance *prototype* so the object the
  // program sees has no own properties, exactly like a real generator object --
  // the equivalence checker encodes own properties, and a real generator encodes
  // as an empty object.
  var proto = {
    next: function (v) { return resume(v, false, false); },
    return: function (v) { return resume(v, true, false); },
    throw: function (e) { return resume(e, false, true); }
  };
  proto[Symbol.iterator] = function () { return this; };
  return Object.create(proto);
}
`,
    ["__hbc_delegated"],
  ),

  // -------------------------------------------------------------------------
  // §7.2 — v>=97 generator shim. The lowered body is a complete state machine
  // that keeps its status and resume index in environment slots and returns the
  // `{value, done}` object itself, so the shim is only the iterator-protocol
  // adapter. Action codes read off the v99 dump of 23-generator-basic function
  // #3: `LoadParam r3, 1` is the action and `LoadParam r0, 2` the value;
  // action 1 reaches `Throw r0` and action 2 the `{value, done: true}` arm.
  // -------------------------------------------------------------------------
  h(
    "__hbc_makeGeneratorLowered",
    `
function __hbc_makeGeneratorLowered(body) {
  // Own-property-free, like a real generator object (see __hbc_makeGenerator).
  var proto = {
    next: function (v) { return body(0, v); },
    throw: function (e) { return body(1, e); },
    return: function (v) { return body(2, v); }
  };
  proto[Symbol.iterator] = function () { return this; };
  return Object.create(proto);
}
`,
  ),

  // §8 — an **unmapped** arguments object at every version we target: Hermes
  // does not alias parameters, and emitting a spec-compliant mapped object here
  // would be a bug, not a fix (docs/EQUIVALENCE.md §5.2).
  h(
    "__hbc_arguments",
    `
var __hbc_arguments = (function () {
  "use strict";
  var make = function () { return arguments; };
  return function (a) { return make.apply(undefined, a); };
})();
`,
  ),

  // IteratorBegin/Next/Close. Hermes has a fast path that represents the state
  // of an unmodified array iteration as an integer index; taking the ordinary
  // iterator every time is observationally the same and much simpler. Both
  // helpers return `[value, newState]` because the opcodes write two registers.
  h(
    "__hbc_iterBegin",
    `
function __hbc_iterBegin(src) {
  var m = src === null || src === undefined ? undefined : src[Symbol.iterator];
  if (typeof m !== "function") {
    // V8 has two texts for this: one built from the *source expression* (for
    // for-of and spread) and one built from the value alone (for
    // destructuring, where no expression text exists). Only the second is
    // reproducible from bytecode -- register names are not the program's names
    // -- so it is the one emitted.
    var t = typeof src;
    var d = src === null ? "object null" : t === "undefined" ? "undefined" : t === "number" || t === "boolean" ? t + " " + String(src) : t;
    throw new TypeError(d + " is not iterable (cannot read property Symbol(Symbol.iterator))");
  }
  var it = m.call(src);
  return [it, it.next];
}
`,
  ),
  h(
    "__hbc_iterNext",
    `
function __hbc_iterNext(it, next) {
  if (it === undefined) return [undefined, undefined];
  var n = next.call(it);
  if (n === null || typeof n !== "object") throw new TypeError("iterator result is not an object");
  if (n.done) return [undefined, undefined];
  return [n.value, it];
}
`,
  ),
  h(
    "__hbc_iterClose",
    `
function __hbc_iterClose(it, ignoreInner) {
  if (it === null || it === undefined || typeof it !== "object") return;
  var ret = it.return;
  if (ret === null || ret === undefined) return;
  if (ignoreInner) {
    try { ret.call(it); } catch (e) { /* IteratorClose(..., true) swallows this */ }
    return;
  }
  var r = ret.call(it);
  if (r === null || typeof r !== "object") throw new TypeError("iterator.return() did not return an object");
}
`,
  ),

  // GetPNameList / GetNextPName. `for...in` order and inherited-enumerable
  // filtering are exactly what the enumerator produces, so the list is built
  // with `for...in` itself; `GetNextPName` re-checks existence because a
  // property deleted during the loop must be skipped.
  h(
    "__hbc_pnames",
    `
function __hbc_pnames(o) {
  if (o === null || o === undefined) return undefined;
  var a = [];
  for (var k in Object(o)) a.push(k);
  return a;
}
`,
  ),
  h(
    "__hbc_nextPName",
    `
function __hbc_nextPName(list, obj, i) {
  var o = Object(obj);
  while (i < list.length) {
    var k = list[i++];
    if (k in o) return [k, i];
  }
  return [undefined, i];
}
`,
  ),

  // ---- internal CallBuiltin entries ---------------------------------------
  h(
    "__hbc_b_apply",
    `
function __hbc_b_apply(fn, args, thisVal) {
  if (arguments.length >= 3) return Reflect.apply(fn, thisVal, args);
  return Reflect.construct(fn, args);
}
`,
  ),
  h(
    "__hbc_b_applyWithNewTarget",
    `
function __hbc_b_applyWithNewTarget(fn, args, newTarget) {
  return Reflect.construct(fn, args, newTarget);
}
`,
  ),
  h(
    "__hbc_b_arraySpread",
    `
function __hbc_b_arraySpread(target, source, index) {
  var i = index;
  var m = source === null || source === undefined ? undefined : source[Symbol.iterator];
  if (typeof m !== "function") throw new TypeError("is not iterable");
  var it = m.call(source);
  for (;;) {
    var n = it.next();
    if (n.done) break;
    target[i++] = n.value;
  }
  return i;
}
`,
  ),
  h(
    "__hbc_b_copyDataProperties",
    `
function __hbc_b_copyDataProperties(target, source, excluded) {
  if (source === null || source === undefined) return target;
  var o = Object(source);
  var keys = Reflect.ownKeys(o);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var d = Object.getOwnPropertyDescriptor(o, k);
    if (d === undefined || !d.enumerable) continue;
    if (excluded !== null && excluded !== undefined && k in Object(excluded)) continue;
    target[k] = o[k];
  }
  return target;
}
`,
  ),
  h(
    "__hbc_b_copyRestArgs",
    `
function __hbc_b_copyRestArgs(args, from) {
  var out = [];
  for (var i = from; i < args.length; i++) out.push(args[i]);
  return out;
}
`,
  ),
  h(
    "__hbc_b_ensureObject",
    `
function __hbc_b_ensureObject(v, message) {
  if (v === null || (typeof v !== "object" && typeof v !== "function")) throw new TypeError(message);
  return undefined;
}
`,
  ),
  h(
    "__hbc_b_getMethod",
    `
function __hbc_b_getMethod(o, key) {
  var f = o === null || o === undefined ? undefined : o[key];
  if (f === null || f === undefined) return undefined;
  if (typeof f !== "function") throw new TypeError("is not a function");
  return f;
}
`,
  ),
  // The template object must be the *same* object every time the same tagged
  // template is evaluated, so this one helper keeps a private cache. Raw
  // strings come first and cooked second; `dup` means they coincide (measured
  // on 44-tagged-templates at v94: getTemplateObject(0, false, "a\\\\n",
  // "b\\\\tc", "d", "a\\n", "b\\tc", "d")).
  h(
    "__hbc_b_getTemplateObject",
    `
var __hbc_b_getTemplateObject = (function () {
  var cache = new Map();
  return function (id, dup) {
    var hit = cache.get(id);
    if (hit !== undefined) return hit;
    var strings = Array.prototype.slice.call(arguments, 2);
    var n = dup ? strings.length : strings.length / 2;
    var raw = strings.slice(0, n);
    var cooked = dup ? raw.slice() : strings.slice(n);
    Object.defineProperty(cooked, "raw", { value: Object.freeze(raw) });
    Object.freeze(cooked);
    cache.set(id, cooked);
    return cooked;
  };
})();
`,
  ),
  h(
    "__hbc_b_initRegexNamedGroups",
    `
function __hbc_b_initRegexNamedGroups(re) {
  return re;
}
`,
  ),
  h(
    "__hbc_b_throwTypeError",
    `
function __hbc_b_throwTypeError(message) {
  throw new TypeError(message);
}
`,
  ),
  h(
    "__hbc_b_throwReferenceError",
    `
function __hbc_b_throwReferenceError(message) {
  throw new ReferenceError(message);
}
`,
  ),
  h(
    "__hbc_b_silentSetPrototypeOf",
    `
function __hbc_b_silentSetPrototypeOf(o, p) {
  try { Object.setPrototypeOf(o, p); } catch (e) { /* "silent" is the point */ }
  return undefined;
}
`,
  ),
  h(
    "__hbc_b_exportAll",
    `
function __hbc_b_exportAll(target, source) {
  for (var k in source) if (k !== "default") target[k] = source[k];
  return undefined;
}
`,
  ),
  // Async functions: the compiler lowers them to a generator plus a driver
  // intrinsic (`spawnAsync` at v84-v98, `makeAsyncIterator` at v99).
  h(
    "__hbc_b_spawnAsync",
    `
function __hbc_b_spawnAsync(fn, thisArg, args) {
  return new Promise(function (resolve, reject) {
    var gen = Reflect.apply(fn, thisArg, args === undefined ? [] : args);
    function step(method, value) {
      var r;
      try {
        r = gen[method](value);
      } catch (e) {
        reject(e);
        return;
      }
      if (r.done) {
        resolve(r.value);
        return;
      }
      Promise.resolve(r.value).then(
        function (v) { step("next", v); },
        function (e) { step("throw", e); }
      );
    }
    step("next", undefined);
  });
}
`,
  ),
  h("__hbc_b_makeAsyncIterator", `var __hbc_b_makeAsyncIterator = __hbc_b_spawnAsync;`, ["__hbc_b_spawnAsync"]),
  h(
    "__hbc_b_awaitAsyncGenerator",
    `
function __hbc_b_awaitAsyncGenerator(v) {
  return Promise.resolve(v);
}
`,
  ),
  h(
    "__hbc_b_requireFast",
    `
function __hbc_b_requireFast(id) {
  throw new TypeError("hbc2js: require(" + String(id) + ") is not available outside a Metro host");
}
`,
  ),
  h(
    "__hbc_b_generatorSetDelegated",
    `
function __hbc_b_generatorSetDelegated() {
  __hbc_delegated = true;
  return undefined;
}
`,
    ["__hbc_delegated"],
  ),
  h(
    "__hbc_b_functionPrototypeApply",
    `
function __hbc_b_functionPrototypeApply(fn, thisArg, args) {
  return Function.prototype.apply.call(fn, thisArg, args);
}
`,
  ),
  h(
    "__hbc_b_functionPrototypeCall",
    `
function __hbc_b_functionPrototypeCall(fn) {
  return Function.prototype.apply.call(fn, arguments[1], Array.prototype.slice.call(arguments, 2));
}
`,
  ),
  h(
    "__hbc_b_applyArguments",
    `
function __hbc_b_applyArguments(callerArgs, fn, thisArg, newTarget) {
  // Measured on 33-class-inheritance-super v99 function #7: an implicit derived
  // constructor forwards super(...arguments) as
  // applyArguments(superClass, allocatedThis, new.target).
  if (newTarget !== undefined) return Reflect.construct(fn, Array.prototype.slice.call(callerArgs), newTarget);
  return Reflect.apply(fn, thisArg, callerArgs);
}
`,
  ),
]);

/** Helper sources for `used`, in dependency order, deterministic. */
export function helperPrelude(used: Iterable<string>): { readonly code: string; readonly names: readonly string[] } {
  const want = new Set<string>();
  const visit = (name: string): void => {
    if (want.has(name)) return;
    const helper = HELPERS[name];
    if (helper === undefined) return;
    for (const d of helper.deps) visit(d);
    want.add(name);
  };
  for (const n of [...used].sort()) visit(n);
  const ordered = Object.keys(HELPERS).filter((n) => want.has(n));
  return { code: ordered.map((n) => HELPERS[n]!.source).join("\n"), names: ordered };
}
