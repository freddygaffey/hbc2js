// docs/specs/06-harness.md §1 — port of tools/equiv/src/fuzz.mjs, unchanged
// (generator drivers stay). Property-based differential testing of functions
// the program leaves on the global object.
//
// This is the cheapest way to turn a single-run trace into something much
// stronger: a program that prints nothing but defines `function f(a,b)` is
// invisible to execution tracing and completely covered by calling `f` a few
// hundred times on both sides and diffing the results.
//
// It is *differential*, not spec-based: we never assert what `f` should
// return, only that both sides agree. Corpus generation is seeded, so a
// failure is reproducible from the seed alone.

// Values chosen for where JS semantics fork: coercion (`""`, `"0"`, `[]`),
// identity (`-0`, `NaN`), the numeric tower (bigint vs number), and the
// property-lookup path (null-prototype objects, proxies).
export const CORPUS: ReadonlyArray<() => unknown> = [
  () => undefined,
  () => null,
  () => true,
  () => false,
  () => 0,
  () => -0,
  () => 1,
  () => -1,
  () => 2,
  () => 42,
  () => 0.1,
  () => -1.5,
  () => NaN,
  () => Infinity,
  () => -Infinity,
  () => Number.MAX_SAFE_INTEGER,
  () => Number.MIN_SAFE_INTEGER,
  () => 2 ** 31,
  () => -(2 ** 31),
  () => 0n,
  () => 1n,
  () => -4057069294949984n,
  () => "",
  () => "0",
  () => "1",
  () => "abc",
  () => " \t\n ",
  () => "É  ",
  () => "[object Object]",
  () => [],
  () => [1, 2, 3],
  () => [[1], [2]],
  () => ["a", "b"],
  () => new Array(3),
  () => ({}),
  () => ({ a: 1, b: "x" }),
  () => Object.create(null),
  () => ({ valueOf: () => 7 }),
  () => ({ toString: () => "ts" }),
  () => ({ length: 2, 0: "a", 1: "b" }),
  () => new Map([[1, "a"]]),
  () => new Set([1, 2]),
  () => /a(b)c/g,
  () => new Date(0),
  () => new Error("boom"),
  () =>
    function named(x: unknown): unknown {
      return x;
    },
  () => (x: unknown): unknown => x,
  () => Symbol("s"),
];

export type NextCase = (arity: number) => unknown[];

export function makeCaseGenerator(_seed: number, random: () => number): NextCase {
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(random() * arr.length) % arr.length]!;
  return function nextCase(arity: number): unknown[] {
    const n = Math.max(0, Math.min(8, arity));
    const args: unknown[] = [];
    for (let i = 0; i < n; i++) args.push(pick(CORPUS)());
    return args;
  };
}

/** Deterministic argument tuples for one function: first the systematic ones
 *  (all-undefined, arity-1, arity+1), then `count` seeded random tuples. */
export function* cases(fn: (...args: unknown[]) => unknown, count: number, nextCase: NextCase): Generator<unknown[]> {
  const a = fn.length;
  yield [];
  if (a > 0) yield new Array(a).fill(undefined) as unknown[];
  for (let i = 0; i < count; i++) yield nextCase(a);
  if (a > 0) yield nextCase(a + 1);
}
