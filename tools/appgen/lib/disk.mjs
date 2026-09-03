// tools/appgen/lib/disk.mjs — preflight free-disk check
// (docs/specs/09-fuzzing.md §2.4: "refuse to start if free disk < 15 GB").
// Uses fs.statfsSync (Node >=18.15, available on both macOS and Linux) so
// there is no platform-specific `df` parsing to maintain.
import { statfsSync } from "node:fs";

export const MIN_FREE_BYTES = 15 * 1024 * 1024 * 1024; // 15 GB, spec §2.4

/** Returns free bytes available on the filesystem containing `path`. */
export function freeBytes(path) {
  const s = statfsSync(path);
  return s.bavail * s.bsize;
}

/** Throws if free disk on `path`'s filesystem is below the spec's 15 GB
 *  preflight bound. Callers (build.mjs) call this before any workspace or
 *  npm-cache write. */
export function preflightDiskCheck(path, { minFreeBytes = MIN_FREE_BYTES } = {}) {
  const free = freeBytes(path);
  if (free < minFreeBytes) {
    throw new Error(
      `appgen preflight: only ${(free / 1e9).toFixed(1)} GB free at ${path}, ` +
      `need >= ${(minFreeBytes / 1e9).toFixed(1)} GB (docs/specs/09-fuzzing.md §2.4)`
    );
  }
  return free;
}
