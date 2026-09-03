// tools/appgen/lib/prng.mjs — deterministic seeded PRNG for the app-gen
// fuzzer (docs/specs/09-fuzzing.md §2). Zero-dependency, same convention as
// tools/e2e/*.mjs. Seed may be any string or number; it is folded into a
// 32-bit integer with FNV-1a, then mulberry32 drives all subsequent draws so
// that `seed -> sequence` is byte-identical across processes/platforms.

/** FNV-1a 32-bit hash of a string, used to fold an arbitrary seed value into
 *  the 32-bit integer state mulberry32 wants. */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, deterministic PRNG. Returns a function that
 *  yields floats in [0, 1) on each call, advancing internal state. */
export function mulberry32(seed32) {
  let a = seed32 >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded RNG helper object with the small set of draw primitives the
 *  generator needs, all derived from one mulberry32 stream so the whole
 *  generation is reproducible from a single seed. */
export function makeRng(seed) {
  const seed32 = typeof seed === "number" ? (seed >>> 0) : fnv1a32(String(seed));
  const next = mulberry32(seed32);
  return {
    seed32,
    float: () => next(),
    int(maxExclusive) {
      return Math.floor(next() * maxExclusive);
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    /** Pick `count` distinct items from `arr` (no replacement), preserving
     *  the RNG's deterministic draw order. */
    pickDistinct(arr, count) {
      const pool = arr.slice();
      const out = [];
      for (let i = 0; i < count && pool.length > 0; i++) {
        const idx = Math.floor(next() * pool.length);
        out.push(pool[idx]);
        pool.splice(idx, 1);
      }
      return out;
    },
  };
}
