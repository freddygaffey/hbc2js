// docs/specs/00-project-skeleton.md §2, §9.8; docs/specs/01-parser.md §3.3.
// ASCII/UTF-16LE decode. Do NOT use TextDecoder("utf-16le") — it replaces unpaired
// surrogates with U+FFFD and HBC strings legitimately contain them. Hand-roll instead.

const CHUNK = 4096;

/** Decode `length` bytes as Latin-1 (byte-per-char). Lossless even for bytes >= 0x80,
 *  which a corrupt file can produce; equivalent to how Hermes stores narrow strings. */
export function decodeAscii(bytes: Uint8Array, offset: number, length: number): string {
  const parts: string[] = [];
  for (let i = 0; i < length; i += CHUNK) {
    const end = Math.min(i + CHUNK, length);
    const codes = new Array<number>(end - i);
    for (let j = i; j < end; j++) codes[j - i] = bytes[offset + j]!;
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join("");
}

/** Decode `length` UTF-16 code units (2*length bytes), little-endian, code-unit by
 *  code-unit. Never uses TextDecoder (see module doc). */
export function decodeUtf16(bytes: Uint8Array, offset: number, length: number): string {
  const parts: string[] = [];
  for (let i = 0; i < length; i += CHUNK) {
    const end = Math.min(i + CHUNK, length);
    const codes = new Array<number>(end - i);
    for (let j = i; j < end; j++) {
      const byteOff = offset + j * 2;
      const lo = bytes[byteOff]!;
      const hi = bytes[byteOff + 1]!;
      codes[j - i] = lo | (hi << 8);
    }
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join("");
}
