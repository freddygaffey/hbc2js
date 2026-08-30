#!/usr/bin/env node
// tools/pkgsig/bulk/baseline-subtract.mjs — the D17c fix
// (docs/PACKAGE-SIGNATURES.md §5.2/§6.4): subtract the toolchain/foundation
// baseline's exact-hash set from a raw fingerprint before it's written into
// the bulk DB, exactly as the curated `tools/pkgsig/db/*.json` starter set
// already has done to it (see that directory's `subtractedBaselines` field
// and its `_baselines/` subdirectory) — no exported function does this in
// `src/deps` today (`src/deps/confirm.ts` writes raw, unsubtracted
// signatures; only the pre-promotion `build-db.mjs` prototype did this, and
// it wasn't carried over into the typed `src/deps` pipeline), so this file
// ports the logic locally, scoped to `tools/pkgsig/bulk/**` per this task's
// ownership split. `test-baseline-subtract.mjs` checks it reproduces the
// checked-in `tools/pkgsig/db/redux@4.2.1__hbc94.json` byte-for-byte from
// its own raw (pre-subtraction) function set reconstructed from the real,
// checked-in baseline files.
//
// A package's raw fingerprint (from `fingerprintModule`) always includes
// every function in the whole bundle Metro produced for
// `require(<pkg>)` — not just <pkg>'s own code, but React Native's own
// polyfills/require-runtime and (when the scaffold's own entry pulls them
// in) React/React Native's full internals, since those are common to every
// bundle built from the same scaffold regardless of what the target package
// itself needs. Without subtracting that shared boilerplate out, a target
// app's ordinary Metro/RN scaffolding functions collide against every
// bulk-built package simultaneously and clear "confirmed" tier thresholds
// on packages that contributed almost nothing of their own
// (docs/PACKAGE-SIGNATURES.md §6.4).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Load every `_baselines/*__hbc<hbcVersion>.json` file under `dbDir` and
 * union their function `exactHash` sets, one baseline set per (RN, hbc)
 * scaffold combination (docs/PACKAGE-SIGNATURES.md §3.3/§5.2: a baseline is
 * only valid for its exact toolchain tuple, never extrapolated across HBC
 * versions). Returns the union `Set<hash>` plus the relative paths that
 * contributed to it (for `SigDbFile.subtractedBaselines`, matching the
 * format already used by the curated `tools/pkgsig/db/*.json` files).
 */
export function computeBaselineUnion(dbDir, hbcVersion) {
  const dir = join(dbDir, "_baselines");
  const hashes = new Set();
  const paths = [];
  if (!existsSync(dir)) return { hashes, paths };
  const suffix = `__hbc${hbcVersion}.json`;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json") || !name.endsWith(suffix)) continue;
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue; // mid-write or malformed — same tolerance as assemble.sh
    }
    if (!doc || !Array.isArray(doc.functions)) continue;
    for (const f of doc.functions) {
      if (typeof f.exactHash === "string") hashes.add(f.exactHash);
    }
    paths.push(`_baselines/${name}`);
  }
  return { hashes, paths };
}

/** True if every recognised baseline kind (metro-toolchain-empty,
 *  react-foundation, react-native-foundation) is represented among
 *  `paths` (as produced by `computeBaselineUnion`) — a job should never
 *  silently write a "fixed" signature using a partial baseline set. */
export function hasCompleteBaselineSet(paths) {
  const kinds = new Set(["metro-toolchain-empty", "react-foundation", "react-native-foundation"]);
  for (const p of paths) {
    for (const kind of kinds) {
      if (p.includes(`/${kind}@`)) kinds.delete(kind);
    }
  }
  return kinds.size === 0;
}

/**
 * Subtract `baselineHashes` from a raw `fingerprintModule()` result.
 * Functions whose `exactHash` is in the baseline set are dropped; modules
 * whose factory function hash is in the baseline set are kept (so the
 * module graph stays complete for D17's `__d()` anchoring, §3.1) but
 * flagged `factoryIsBaseline: true` exactly like the curated DB's own
 * modules already are.
 */
export function subtractBaseline(rawFunctions, rawModules, baselineHashes) {
  const functions = rawFunctions.filter((f) => !baselineHashes.has(f.exactHash));
  const modules = rawModules.map((m) => ({
    ...m,
    factoryIsBaseline: m.factoryExactHash !== null && baselineHashes.has(m.factoryExactHash),
  }));
  return { functions, modules };
}
