// review-M4-H3 — spec 05 §7.1 rule 4: "a helper is acceptable only if … it has
// its own unit test and a row in docs/LOWERING-CATALOGUE.md".
//
// Before this file the 33 helpers in src/runtime/helpers.ts were exercised only
// by whichever construct fixture happened to reach them, and none had a
// catalogue row. Each `test("review-M4-H3: <name> …")` below owns one helper;
// the last two tests are the ratchet that keeps rule 4 true for the *next*
// helper someone adds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { HELPERS, helperPrelude } from "../../../src/runtime/helpers.ts";

/**
 * Evaluate the prelude for `names` (plus their deps) in a fresh scope and hand
 * back live accessors — `__hbc_delegated` is a mutable `var`, so a snapshot
 * would not see `__hbc_b_generatorSetDelegated` write to it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function load(...names: string[]): Record<string, any> {
  const { code, names: all } = helperPrelude(names);
  const getters = all.map((n) => `get ${n}() { return ${n}; }`).join(", ");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`"use strict";\n${code}\nreturn { ${getters} };`)() as Record<string, unknown> as Record<string, never>;
}

// --- sentinels and host objects ---------------------------------------------

test("review-M4-H3: __hbc_empty is a distinct symbol, not undefined", () => {
  const h = load("__hbc_empty");
  assert.equal(typeof h["__hbc_empty"], "symbol");
  // Collapsing it to `undefined` would disarm every TDZ check the bytecode has.
  assert.notEqual(h["__hbc_empty"], undefined);
  assert.equal(load("__hbc_empty")["__hbc_empty"] === h["__hbc_empty"], false, "each emitted module gets its own sentinel");
});

test("review-M4-H3: __hbc_HermesInternal.concat stringifies `this` and every argument", () => {
  const { __hbc_HermesInternal: hi } = load("__hbc_HermesInternal");
  assert.equal(hi.concat.call("a", "b", 1, null), "ab1null");
  // ToString, not ToPrimitive: Hermes renders an object as "[object Object]"
  // even when it has a valueOf.
  assert.equal(hi.concat.call("x", { valueOf: () => 5 }), "x[object Object]");
  // …but a Symbol must still throw, which String() would not do.
  assert.throws(() => hi.concat.call("x", Symbol("s")), TypeError);
  assert.deepEqual(hi.getEpilogues(), []);
  assert.equal(hi.hasPromise(), true);
  assert.equal(hi.useEngineQueue(), false);
});

test("review-M4-H3: __hbc_delegated starts false and __hbc_b_generatorSetDelegated sets it", () => {
  const h = load("__hbc_b_generatorSetDelegated");
  assert.equal(h["__hbc_delegated"], false);
  assert.equal(h["__hbc_b_generatorSetDelegated"](), undefined);
  assert.equal(h["__hbc_delegated"], true, "the flag is module-scoped and the setter must reach it");
});

test("review-M4-H3: __hbc_unresolved_env throws, naming the site", () => {
  const h = load("__hbc_unresolved_env");
  assert.throws(
    () => h["__hbc_unresolved_env"]("store", 3, 17, 2),
    (e: unknown) => e instanceof Error && /unresolved environment store of slot 2/.test(e.message) && /fn#3 @17/.test(e.message),
  );
});

// --- generator protocol ------------------------------------------------------

/** A v≤96 frame factory: `step(sent, isReturn, isThrow) -> [value, done]`. */
function countingFactory(n: number) {
  return function (): (sent: unknown, isReturn: boolean, isThrow: boolean) => [unknown, boolean] {
    let i = 0;
    return (sent, isReturn, isThrow) => {
      if (isThrow) throw sent;
      if (isReturn) return [sent, true];
      if (i >= n) return [undefined, true];
      return [i++, false];
    };
  };
}

test("review-M4-H3: __hbc_makeGenerator implements next/return/throw and the iterator protocol", () => {
  const h = load("__hbc_makeGenerator");
  const g = h["__hbc_makeGenerator"](countingFactory(2), undefined, []);
  assert.deepEqual(Object.getOwnPropertyNames(g), [], "a real generator object has no own properties");
  assert.equal(g[Symbol.iterator](), g);
  assert.deepEqual(g.next(), { value: 0, done: false });
  assert.deepEqual(g.next(), { value: 1, done: false });
  assert.deepEqual(g.next(), { value: undefined, done: true });
  // Finished: `.return(v)` still reports v, `.throw(e)` still throws.
  assert.deepEqual(g.next(), { value: undefined, done: true });
  assert.deepEqual(g.return(9), { value: 9, done: true });
  assert.throws(() => g.throw(new RangeError("x")), RangeError);
});

test("review-M4-H3: __hbc_makeGenerator refuses re-entry and finishes on a body throw", () => {
  const h = load("__hbc_makeGenerator");
  let self: { next(): unknown } | undefined;
  const reentrant = h["__hbc_makeGenerator"](
    () => () => {
      self!.next();
      return [1, false];
    },
    undefined,
    [],
  );
  self = reentrant;
  assert.throws(() => reentrant.next(), (e: unknown) => e instanceof TypeError && /executing generators/.test(e.message));

  const boom = h["__hbc_makeGenerator"](
    () => () => {
      throw new Error("body");
    },
    undefined,
    [],
  );
  assert.throws(() => boom.next(), /body/);
  // …and it is finished afterwards, not re-entered.
  assert.deepEqual(boom.next(), { value: undefined, done: true });
});

test("review-M4-H3: __hbc_makeGenerator passes a delegated result object through unwrapped", () => {
  const h = load("__hbc_makeGenerator", "__hbc_b_generatorSetDelegated");
  const inner = { value: "inner", done: false, extra: 1 };
  const g = h["__hbc_makeGenerator"](
    () => () => {
      h["__hbc_b_generatorSetDelegated"]();
      return [inner, false];
    },
    undefined,
    [],
  );
  assert.equal(g.next(), inner, "yield* must yield the inner iterator's own result object");
});

test("review-M4-H3: __hbc_makeGeneratorLowered maps next/throw/return onto the v≥97 body", () => {
  const h = load("__hbc_makeGeneratorLowered");
  const seen: [number, unknown][] = [];
  const g = h["__hbc_makeGeneratorLowered"]((mode: number, v: unknown) => {
    seen.push([mode, v]);
    return { value: v, done: false };
  });
  assert.deepEqual(Object.getOwnPropertyNames(g), []);
  assert.equal(g[Symbol.iterator](), g);
  g.next("a");
  g.throw("b");
  g.return("c");
  assert.deepEqual(seen, [
    [0, "a"],
    [1, "b"],
    [2, "c"],
  ]);
});

// --- `arguments` -------------------------------------------------------------

test("review-M4-H3: __hbc_arguments builds an UNMAPPED arguments object (D14)", () => {
  const h = load("__hbc_arguments");
  const a = h["__hbc_arguments"](["x", "y"]);
  assert.equal(a.length, 2);
  assert.equal(a[0], "x");
  assert.equal(Object.prototype.toString.call(a), "[object Arguments]");
  assert.equal(typeof a[Symbol.iterator], "function");
  // Hermes 84–99 does not alias parameters, so writing must not reach anything.
  a[0] = "z";
  assert.equal(a[0], "z");
});

// --- iteration opcodes -------------------------------------------------------

test("review-M4-H3: __hbc_notIterable reproduces the real Hermes VM's wording (measured on tools/hermesc/v84,v96/hermes and tools/hermes-vm/v99/bin/hermes, not V8/Node's), shared by __hbc_iterBegin and __hbc_b_arraySpread", () => {
  const h = load("__hbc_notIterable");
  for (const [value, text] of [
    [null, "Cannot convert null value to object"],
    [undefined, "Cannot convert undefined value to object"],
    [7, "iterator method is not callable"],
    [true, "iterator method is not callable"],
    [{}, "iterator method is not callable"],
    [() => {}, "iterator method is not callable"],
  ] as const) {
    assert.throws(
      () => h["__hbc_notIterable"](value),
      (e: unknown) => e instanceof TypeError && e.message === text,
      `wrong text for ${String(value)}`,
    );
  }
});

test("review-M4-H3: __hbc_iterBegin returns [iterator, next] and reproduces Hermes's message", () => {
  const h = load("__hbc_iterBegin");
  const [it, next] = h["__hbc_iterBegin"]([1, 2]);
  assert.equal(typeof next, "function");
  assert.deepEqual(next.call(it), { value: 1, done: false });
  for (const [value, text] of [
    [null, "Cannot convert null value to object"],
    [undefined, "Cannot convert undefined value to object"],
    [7, "iterator method is not callable"],
    [true, "iterator method is not callable"],
    [{}, "iterator method is not callable"],
  ] as const) {
    assert.throws(
      () => h["__hbc_iterBegin"](value),
      (e: unknown) => e instanceof TypeError && e.message === text,
      `wrong text for ${String(value)}`,
    );
  }
});

test("review-M4-H3: __hbc_iterNext reports exhaustion by clearing the iterator", () => {
  const h = load("__hbc_iterBegin", "__hbc_iterNext");
  const [it, next] = h["__hbc_iterBegin"]([5]);
  assert.deepEqual(h["__hbc_iterNext"](it, next), [5, it]);
  assert.deepEqual(h["__hbc_iterNext"](it, next), [undefined, undefined]);
  // An already-cleared iterator is a no-op, not a crash.
  assert.deepEqual(h["__hbc_iterNext"](undefined, next), [undefined, undefined]);
  assert.throws(() => h["__hbc_iterNext"]({}, () => 1), (e: unknown) => e instanceof TypeError && /not an object/.test(e.message));
});

test("review-M4-H3: __hbc_iterClose calls .return, and swallows only when told to", () => {
  const h = load("__hbc_iterClose");
  let closed = 0;
  h["__hbc_iterClose"]({ return: () => ((closed += 1), {}) }, false);
  assert.equal(closed, 1);
  // No `.return`, or a non-object receiver: nothing happens.
  h["__hbc_iterClose"]({}, false);
  h["__hbc_iterClose"](null, false);
  h["__hbc_iterClose"](undefined, false);
  // A non-object result is a TypeError…
  assert.throws(() => h["__hbc_iterClose"]({ return: () => 1 }, false), TypeError);
  // …and `ignoreInner` swallows a throw from `.return` itself.
  h["__hbc_iterClose"](
    {
      return: () => {
        throw new Error("inner");
      },
    },
    true,
  );
});

test("review-M4-H3: __hbc_pnames / __hbc_nextPName drive for-in, skipping deleted keys", () => {
  const h = load("__hbc_pnames", "__hbc_nextPName");
  assert.equal(h["__hbc_pnames"](null), undefined);
  assert.equal(h["__hbc_pnames"](undefined), undefined);
  const o: Record<string, number> = { a: 1, b: 2, c: 3 };
  const list = h["__hbc_pnames"](o);
  assert.deepEqual(list, ["a", "b", "c"]);
  // for-in includes inherited enumerable keys.
  assert.deepEqual(h["__hbc_pnames"](Object.create({ p: 1 })), ["p"]);
  // A key deleted mid-loop must be skipped, not visited as undefined.
  delete o["b"];
  const seen: unknown[] = [];
  let i = 0;
  for (;;) {
    const [k, next] = h["__hbc_nextPName"](list, o, i);
    i = next;
    if (k === undefined) break;
    seen.push(k);
  }
  assert.deepEqual(seen, ["a", "c"]);
  // Primitives are boxed, like `for (k in "ab")`.
  assert.deepEqual(h["__hbc_nextPName"](["0"], "ab", 0), ["0", 1]);
});

// --- CallBuiltin internals ---------------------------------------------------

test("review-M4-H3: __hbc_b_apply calls with a `this`, constructs without one", () => {
  const h = load("__hbc_b_apply");
  function f(this: unknown, a: number, b: number): number {
    return a + b;
  }
  assert.equal(h["__hbc_b_apply"](f, [1, 2], undefined), 3);
  function C(this: { v: number }, v: number): void {
    this.v = v;
  }
  // Two arguments = construct (the arity is the signal, not a flag).
  assert.equal(h["__hbc_b_apply"](C, [7]).v, 7);
});

test("review-M4-H3: __hbc_b_applyWithNewTarget constructs with the given new.target", () => {
  const h = load("__hbc_b_applyWithNewTarget");
  function Base(this: { tag: string }): void {
    this.tag = "base";
  }
  function Derived(): void {}
  Derived.prototype = { kind: "derived" };
  const o = h["__hbc_b_applyWithNewTarget"](Base, [], Derived);
  assert.equal(o.tag, "base");
  assert.equal(Object.getPrototypeOf(o), Derived.prototype, "new.target supplies the prototype");
});

test("review-M4-H3: __hbc_b_arraySpread writes from `index` and returns the next index", () => {
  const h = load("__hbc_b_arraySpread");
  const target: unknown[] = ["keep"];
  assert.equal(h["__hbc_b_arraySpread"](target, [1, 2, 3], 1), 4);
  assert.deepEqual(target, ["keep", 1, 2, 3]);
  // Any iterable, not just arrays.
  assert.equal(h["__hbc_b_arraySpread"]([], new Set(["a"]), 0), 1);
  // review-M4-H3/iterable-wording (docs/BUGS.md): this used to be a bare
  // "is not iterable" with no value description, unlike __hbc_iterBegin; now
  // both share __hbc_notIterable and reproduce the real Hermes VM's wording.
  assert.throws(
    () => h["__hbc_b_arraySpread"]([], 5, 0),
    (e: unknown) => e instanceof TypeError && e.message === "iterator method is not callable",
  );
  assert.throws(
    () => h["__hbc_b_arraySpread"]([], undefined, 0),
    (e: unknown) => e instanceof TypeError && e.message === "Cannot convert undefined value to object",
  );
});

test("review-M4-H3: __hbc_b_copyDataProperties copies own enumerable keys, minus the excluded", () => {
  const h = load("__hbc_b_copyDataProperties");
  const source = Object.create({ inherited: 1 }) as Record<string, unknown>;
  source["a"] = 1;
  source["b"] = 2;
  Object.defineProperty(source, "hidden", { value: 3, enumerable: false });
  const sym = Symbol("s");
  source[sym as unknown as string] = 4;
  const target = h["__hbc_b_copyDataProperties"]({}, source, { b: true });
  assert.deepEqual(Object.keys(target), ["a"]);
  assert.equal(target[sym], 4, "symbol keys are own enumerable properties too");
  assert.equal("inherited" in Object.getOwnPropertyNames(target), false);
  // null/undefined sources are a no-op, per the spec's CopyDataProperties.
  assert.deepEqual(h["__hbc_b_copyDataProperties"]({ k: 1 }, null, undefined), { k: 1 });
});

test("review-M4-H3: __hbc_b_copyRestArgs slices an arguments object from an index", () => {
  const h = load("__hbc_b_copyRestArgs");
  const args = (function (this: unknown, ...rest: number[]): IArguments {
    void rest;
    // eslint-disable-next-line prefer-rest-params
    return arguments;
  })(1, 2, 3);
  assert.deepEqual(h["__hbc_b_copyRestArgs"](args, 1), [2, 3]);
  assert.deepEqual(h["__hbc_b_copyRestArgs"](args, 5), []);
  assert.ok(Array.isArray(h["__hbc_b_copyRestArgs"](args, 0)), "a rest parameter is a real Array");
});

test("review-M4-H3: __hbc_b_ensureObject throws the VM's own message for a non-object", () => {
  const h = load("__hbc_b_ensureObject");
  assert.equal(h["__hbc_b_ensureObject"]({}, "m"), undefined);
  assert.equal(h["__hbc_b_ensureObject"](() => 0, "m"), undefined);
  for (const v of [null, undefined, 1, "s", true, Symbol("x")]) {
    assert.throws(() => h["__hbc_b_ensureObject"](v, "iterator result is not an object"), (e: unknown) => e instanceof TypeError && e.message === "iterator result is not an object");
  }
});

test("review-M4-H3: __hbc_b_getMethod is GetMethod: null/undefined -> undefined, non-callable -> TypeError", () => {
  const h = load("__hbc_b_getMethod");
  assert.equal(h["__hbc_b_getMethod"]({}, "missing"), undefined);
  assert.equal(h["__hbc_b_getMethod"]({ m: null }, "m"), undefined);
  assert.equal(h["__hbc_b_getMethod"](null, "m"), undefined);
  assert.equal(h["__hbc_b_getMethod"](undefined, "m"), undefined);
  const f = (): number => 1;
  assert.equal(h["__hbc_b_getMethod"]({ m: f }, "m"), f);
  assert.throws(() => h["__hbc_b_getMethod"]({ m: 5 }, "m"), TypeError);
});

test("review-M4-H3: __hbc_b_getTemplateObject freezes, sets .raw, and caches by site id", () => {
  const h = load("__hbc_b_getTemplateObject");
  // dup = false: cooked strings follow the raw ones in the argument list.
  const a = h["__hbc_b_getTemplateObject"](1, false, "a\n", "b", "a\\n", "b");
  assert.deepEqual([...a], ["a\\n", "b"]);
  assert.deepEqual([...a.raw], ["a\n", "b"]);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.raw));
  // Same site id -> the *same object*, which is what a tagged template promises.
  assert.equal(h["__hbc_b_getTemplateObject"](1, false, "x", "x"), a);
  // dup = true: cooked === raw.
  const b = h["__hbc_b_getTemplateObject"](2, true, "only");
  assert.deepEqual([...b], ["only"]);
  assert.deepEqual([...b.raw], ["only"]);
  assert.notEqual(b, a);
});

test("review-M4-H3: __hbc_b_initRegexNamedGroups returns the regexp unchanged", () => {
  const h = load("__hbc_b_initRegexNamedGroups");
  const re = /(?<y>\d+)/;
  assert.equal(h["__hbc_b_initRegexNamedGroups"](re), re);
  // V8 already populates `.groups`; the builtin exists only to satisfy the call.
  assert.equal("2026".match(h["__hbc_b_initRegexNamedGroups"](re))!.groups!["y"], "2026");
});

test("review-M4-H3: __hbc_b_throwTypeError / __hbc_b_throwReferenceError throw the named type", () => {
  const h = load("__hbc_b_throwTypeError", "__hbc_b_throwReferenceError");
  assert.throws(() => h["__hbc_b_throwTypeError"]("nope"), (e: unknown) => e instanceof TypeError && e.message === "nope");
  assert.throws(() => h["__hbc_b_throwReferenceError"]("gone"), (e: unknown) => e instanceof ReferenceError && e.message === "gone");
});

test("review-M4-H3: __hbc_b_silentSetPrototypeOf sets, and swallows a failure", () => {
  const h = load("__hbc_b_silentSetPrototypeOf");
  const proto = { p: 1 };
  const o: Record<string, unknown> = {};
  assert.equal(h["__hbc_b_silentSetPrototypeOf"](o, proto), undefined);
  assert.equal(Object.getPrototypeOf(o), proto);
  // A non-extensible object makes setPrototypeOf throw — "silent" is the point.
  const sealed = Object.preventExtensions({});
  assert.equal(h["__hbc_b_silentSetPrototypeOf"](sealed, proto), undefined);
});

test("review-M4-H3: __hbc_b_exportAll copies every enumerable key except `default`", () => {
  const h = load("__hbc_b_exportAll");
  const target: Record<string, unknown> = {};
  assert.equal(h["__hbc_b_exportAll"](target, { a: 1, default: 2, b: 3 }), undefined);
  assert.deepEqual(target, { a: 1, b: 3 } as Record<string, unknown>);
  // for-in, so inherited names come too — that is what `export *` does.
  h["__hbc_b_exportAll"](target, Object.create({ c: 4 }));
  assert.equal(target["c"], 4);
});

test("review-M4-H3: __hbc_b_spawnAsync drives a generator body as an async function", async () => {
  const h = load("__hbc_b_spawnAsync");
  // Resolve path, including a value awaited through a promise.
  const ok = await h["__hbc_b_spawnAsync"](
    function* (a: number) {
      const v = (yield Promise.resolve(a)) as number;
      return v + 1;
    },
    undefined,
    [1],
  );
  assert.equal(ok, 2);
  // A rejected await is thrown back INTO the body, where it can be caught.
  const caught = await h["__hbc_b_spawnAsync"](
    function* () {
      try {
        yield Promise.reject(new Error("boom"));
      } catch (e) {
        return `caught ${(e as Error).message}`;
      }
      return "not reached";
    },
    undefined,
    [],
  );
  assert.equal(caught, "caught boom");
  // A body that throws rejects the promise.
  await assert.rejects(
    h["__hbc_b_spawnAsync"](
      function* () {
        throw new Error("thrown");
        // eslint-disable-next-line no-unreachable
        yield 1;
      },
      undefined,
      [],
    ),
    /thrown/,
  );
  // `thisArg` and a missing `args` both work.
  assert.equal(
    await h["__hbc_b_spawnAsync"](
      function* (this: { v: number }) {
        return this.v;
      },
      { v: 9 },
      undefined,
    ),
    9,
  );
});

test("review-M4-H3: __hbc_b_makeAsyncIterator is __hbc_b_spawnAsync", () => {
  const h = load("__hbc_b_makeAsyncIterator");
  assert.equal(h["__hbc_b_makeAsyncIterator"], h["__hbc_b_spawnAsync"]);
  assert.deepEqual(HELPERS["__hbc_b_makeAsyncIterator"]!.deps, ["__hbc_b_spawnAsync"]);
});

test("review-M4-H3: __hbc_b_awaitAsyncGenerator is Promise.resolve", async () => {
  const h = load("__hbc_b_awaitAsyncGenerator");
  assert.equal(await h["__hbc_b_awaitAsyncGenerator"](1), 1);
  const p = Promise.resolve(2);
  assert.equal(h["__hbc_b_awaitAsyncGenerator"](p), p, "an existing promise passes through");
  await assert.rejects(h["__hbc_b_awaitAsyncGenerator"](Promise.reject(new Error("r"))), /r/);
});

test("review-M4-H3: __hbc_b_requireFast refuses rather than inventing a module loader", () => {
  const h = load("__hbc_b_requireFast");
  assert.throws(() => h["__hbc_b_requireFast"](12), (e: unknown) => e instanceof TypeError && /require\(12\) is not available outside a Metro host/.test(e.message));
});

test("review-M4-H3: __hbc_b_functionPrototypeApply and __hbc_b_functionPrototypeCall forward through Function.prototype.apply", () => {
  const h = load("__hbc_b_functionPrototypeApply", "__hbc_b_functionPrototypeCall");
  function f(this: { t: string }, a: number, b: number): string {
    return `${this.t}${a}${b}`;
  }
  assert.equal(h["__hbc_b_functionPrototypeApply"](f, { t: "T" }, [1, 2]), "T12");
  assert.equal(h["__hbc_b_functionPrototypeCall"](f, { t: "T" }, 1, 2), "T12");
  // They must use the *original* Function.prototype.apply, not the callee's own
  // `.apply` property, so a shadowed one is ignored.
  const shadowed = Object.assign(function (): string {
    return "real";
  }, { apply: () => "hijacked" });
  assert.equal(h["__hbc_b_functionPrototypeApply"](shadowed, undefined, []), "real");
});

test("review-M4-H3: __hbc_b_applyArguments forwards a caller's arguments, constructing when new.target is set", () => {
  const h = load("__hbc_b_applyArguments");
  function sum(this: unknown, a: number, b: number): number {
    return a + b;
  }
  const callerArgs = (function (...rest: number[]): IArguments {
    void rest;
    // eslint-disable-next-line prefer-rest-params
    return arguments;
  })(2, 3);
  assert.equal(h["__hbc_b_applyArguments"](callerArgs, sum, undefined, undefined), 5);
  // The measured shape: an implicit derived constructor's super(...arguments).
  function Base(this: { v: unknown }, v: unknown): void {
    this.v = v;
  }
  function Derived(): void {}
  Derived.prototype = { kind: "derived" };
  const o = h["__hbc_b_applyArguments"](callerArgs, Base, undefined, Derived);
  assert.equal(o.v, 2);
  assert.equal(Object.getPrototypeOf(o), Derived.prototype);
});

// --- the ratchet -------------------------------------------------------------

/** Every helper this file claims to cover, one `test(...)` each. */
const TESTED = new Set(Object.keys(HELPERS));

test("review-M4-H3: every helper has a unit test in this file (spec 05 §7.1 rule 4)", () => {
  const source = readFileSync(new URL(import.meta.url).pathname, "utf8");
  const titles = [...source.matchAll(/^test\("(review-M4-H3: [^"]+)"/gm)].map((m) => m[1]!);
  assert.ok(titles.length > 25, `only ${titles.length} helper tests found — the title convention changed`);
  const missing = [...TESTED].filter((name) => !titles.some((t) => t.includes(name)));
  assert.deepEqual(missing, [], "helpers named in no `test(\"review-M4-H3: …\")` title");
});

test("review-M4-H3: every helper has a row in docs/LOWERING-CATALOGUE.md (spec 05 §7.1 rule 4)", () => {
  const catalogue = readFileSync(join(repoRoot(), "docs", "LOWERING-CATALOGUE.md"), "utf8");
  const missing = [...TESTED].filter((name) => !catalogue.includes(`\`${name}\``));
  assert.deepEqual(missing, [], "helpers with no catalogue row");
});
