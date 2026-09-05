// src/native/zip.ts — a pure-Node, read-only zip (APK) reader.
// docs/specs/27-native-side.md §L1: the core native-ingestion path must run
// with no external binaries at all ("pure Node, no native binaries in the core
// path"), so this replaces `src/deps/apk.ts`'s `unzip(1)` shell-outs for
// everything spec 27 reads. Layout derived from the PKZIP APPNOTE (public
// format documentation); nothing is copied from any tool.
//
// Read-only, always: we never write, patch or repackage an archive (spec 27 §7).
import { inflateRawSync } from "node:zlib";
import { ErrorCode, Hbc2jsError } from "../errors.ts";

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** One central-directory entry. `offset` is the local-header offset. */
export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly crc32: number;
  readonly offset: number;
}

function u16(b: Uint8Array, o: number): number {
  if (o + 2 > b.length) throw truncated(o, "u16");
  return b[o]! | (b[o + 1]! << 8);
}

function u32(b: Uint8Array, o: number): number {
  if (o + 4 > b.length) throw truncated(o, "u32");
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

function truncated(offset: number, what: string): Hbc2jsError {
  return new Hbc2jsError(ErrorCode.E_TRUNCATED, `zip: read of ${what} ran past end of archive`, { offset });
}

/** Central directory of `bytes`, in file order. Refuses (never guesses) an
 *  archive with no end-of-central-directory record. */
export function readZipDirectory(bytes: Uint8Array): ZipEntry[] {
  // The EOCD is the last record; scan backwards over the max comment length.
  let eocd = -1;
  const min = Math.max(0, bytes.length - (0xffff + 22));
  for (let i = bytes.length - 22; i >= min; i--) {
    if (u32(bytes, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Hbc2jsError(ErrorCode.E_BAD_MAGIC, "zip: no end-of-central-directory record; not a zip/APK", {
      hint: "the native ingester refuses an unreadable container rather than emitting a partial table (spec 27 §1.4)",
    });
  }
  let count = u16(bytes, eocd + 10);
  let dirOffset = u32(bytes, eocd + 16);
  if (dirOffset === 0xffffffff || count === 0xffff) {
    // Zip64: the locator sits immediately before the EOCD.
    const loc = eocd - 20;
    if (loc < 0 || u32(bytes, loc) !== SIG_EOCD64_LOCATOR) {
      throw new Hbc2jsError(ErrorCode.E_TRUNCATED, "zip: zip64 archive without a locator record", { offset: eocd });
    }
    const eocd64 = Number(readU64(bytes, loc + 8));
    count = Number(readU64(bytes, eocd64 + 32));
    dirOffset = Number(readU64(bytes, eocd64 + 48));
  }
  const out: ZipEntry[] = [];
  let p = dirOffset;
  for (let i = 0; i < count; i++) {
    if (u32(bytes, p) !== SIG_CENTRAL) {
      throw new Hbc2jsError(ErrorCode.E_SECTION_MISMATCH, `zip: central-directory entry ${i} has a bad signature`, { offset: p });
    }
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out.push({
      name,
      method: u16(bytes, p + 10),
      crc32: u32(bytes, p + 16),
      compressedSize: u32(bytes, p + 20),
      size: u32(bytes, p + 24),
      offset: u32(bytes, p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readU64(b: Uint8Array, o: number): bigint {
  if (o + 8 > b.length) throw truncated(o, "u64");
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]!);
  return v;
}

/** The decompressed bytes of one entry. Supports stored (0) and deflate (8) —
 *  every method an APK actually uses; anything else is refused, not guessed. */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const p = entry.offset;
  if (u32(bytes, p) !== SIG_LOCAL) {
    throw new Hbc2jsError(ErrorCode.E_SECTION_MISMATCH, `zip: bad local header for ${entry.name}`, { offset: p });
  }
  const nameLen = u16(bytes, p + 26);
  const extraLen = u16(bytes, p + 28);
  const start = p + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw truncated(start, `entry ${entry.name}`);
  const raw = bytes.subarray(start, end);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return new Uint8Array(inflateRawSync(raw));
  throw new Hbc2jsError(ErrorCode.E_UNSUPPORTED_VERSION, `zip: unsupported compression method ${entry.method} for ${entry.name}`, {
    hint: "APKs use stored (0) or deflate (8); an unknown method is refused rather than decoded as a guess",
  });
}

/** Convenience: the entry named `name`, or `null` when the archive has none. */
export function findZipEntry(entries: readonly ZipEntry[], name: string): ZipEntry | null {
  for (const e of entries) if (e.name === name) return e;
  return null;
}
