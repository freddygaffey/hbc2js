// tools/appgen/lib/manifest.mjs — axis fingerprinting + manifest-hash dedup
// for the app-gen fuzzer (docs/specs/09-fuzzing.md §2.1 "duplicate rejection").
// The fingerprint covers exactly the axes this increment varies (router
// shape, dependency-loading style, screen set); later increments add build
// axes (bundler, RN/Hermes version, libraries, obfuscation) per §2.1's table
// without changing this module's contract: `fingerprint(manifest)` is a
// stable string, `isDuplicate(store, fp)` checks membership.
import { createHash } from "node:crypto";

/** Canonical, order-independent fingerprint of the axes that fully
 *  determine a generated app's *shape* (not its seed — two different seeds
 *  that happen to land on the same axis combination are still the same
 *  fingerprint, and the spec calls that "same-app-N-times", the defined
 *  failure). */
export function fingerprint(manifest) {
  const canonical = JSON.stringify({
    routerShape: manifest.routerShape,
    depStyle: manifest.depStyle,
    screens: [...manifest.screens].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function isDuplicate(store, fp) {
  return store.some((entry) => entry.fingerprint === fp);
}

/** Build-axis fingerprint (spec §2.3 item 1: "(rn, bundler, router,
 *  sortedLibs, obfuscation)") — distinct from `fingerprint()`'s app-shape
 *  fingerprint above. Used by the campaign sampler (tools/appgen/campaign.mjs)
 *  for candidate rejection: "a candidate whose axis fingerprint equals any
 *  manifest entry's is rejected outright". `libs` defaults to `[]` (the
 *  libraries axis is not yet varied by the generator). */
export function axisFingerprint({ rnVersion, bundler, router, libs = [], obfuscation }) {
  const canonical = JSON.stringify({
    rnVersion,
    bundler,
    router,
    libs: [...libs].sort(),
    obfuscation,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** spec §2.3 item 2: "once the manifest holds >= 5 triples, no single value
 *  of any axis may exceed 40% of stored triples". Returns the set of axis
 *  values that are currently AT or over quota for `store` (non-evicted
 *  entries only), keyed `"<axis>:<value>"`. */
export function axesOverQuota(store, { axes = ["rnVersion", "bundler", "router", "obfuscation"], quota = 0.4 } = {}) {
  const live = store.filter((e) => !e.evicted);
  const over = new Set();
  if (live.length < 5) return over; // quota not yet in effect
  for (const axis of axes) {
    const counts = new Map();
    for (const e of live) counts.set(e[axis], (counts.get(e[axis]) || 0) + 1);
    for (const [value, count] of counts) {
      if (count / live.length >= quota) over.add(`${axis}:${value}`);
    }
  }
  return over;
}

/** Load a manifest-store JSON array from disk, tolerating a missing file
 *  (fresh store). Shape: `[{ id, seed, fingerprint, createdAt }, ...]`. */
export function loadStore(path, fs) {
  if (!fs.existsSync(path)) return [];
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

export function saveStore(path, fs, store) {
  fs.writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
}
