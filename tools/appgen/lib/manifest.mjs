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

/** Load a manifest-store JSON array from disk, tolerating a missing file
 *  (fresh store). Shape: `[{ id, seed, fingerprint, createdAt }, ...]`. */
export function loadStore(path, fs) {
  if (!fs.existsSync(path)) return [];
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

export function saveStore(path, fs, store) {
  fs.writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
}
