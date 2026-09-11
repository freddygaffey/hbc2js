// src/readability/cache.ts -- spec 28 section 9.3: the content-hash cache.
// One JSON file per key under `cacheDir`: the request digest, the raw
// response text, the parsed result, and the cost. DERIVED data (spec 18
// section 4): gitignored, rebuildable, never authoritative -- the overlay +
// the transaction log are what is authoritative. Pure filesystem; no model,
// no network (asserted mechanically by interface-shape.test.ts over this
// whole directory).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReadabilityResult } from "./types.ts";

export interface CacheCost {
  readonly tokensIn?: number;
  readonly tokensOut?: number;
}

export interface CacheEntry {
  /** The cache key itself, so a file is self-describing when inspected. */
  readonly key: string;
  /** The raw model response text (or the recorded/replayed text). */
  readonly responseText: string;
  /** `parseReadabilityResult(responseText)` at write time, so a reader never
   *  has to re-parse to know what was accepted. */
  readonly result: ReadabilityResult;
  readonly cost?: CacheCost;
}

export function cacheFilePath(cacheDir: string, key: string): string {
  return join(cacheDir, `${key}.json`);
}

/** A cache miss returns `undefined` -- including when the file is present but
 *  unreadable/corrupt, which is treated as a miss rather than a crash (the
 *  cache is derived data; a bad file just costs one re-fetch). */
export function readCacheEntry(cacheDir: string, key: string): CacheEntry | undefined {
  const path = cacheFilePath(cacheDir, key);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CacheEntry;
  } catch {
    return undefined;
  }
}

export function writeCacheEntry(cacheDir: string, entry: CacheEntry): void {
  const path = cacheFilePath(cacheDir, entry.key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`);
}
