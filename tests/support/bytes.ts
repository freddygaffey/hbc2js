// docs/specs/00-project-skeleton.md §2 (tests/support/bytes.ts).
import { readFileSync } from "node:fs";

const cache = new Map<string, Uint8Array>();

/** Read a fixture .hbc as Uint8Array, cached by absolute path. */
export function readBytes(absPath: string): Uint8Array {
  const cached = cache.get(absPath);
  if (cached !== undefined) return cached;
  const buf = readFileSync(absPath);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  cache.set(absPath, bytes);
  return bytes;
}
