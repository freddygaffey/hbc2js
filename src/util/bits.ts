// docs/specs/00-project-skeleton.md §2 (util/bits.ts) — bitfield extraction from
// little-endian 32-bit words. HBC packs several bitfields per word, LSB first.

/** Extract `width` bits starting at bit `offset` (0 = LSB) from an unsigned 32-bit word. */
export function extractBits(word: number, offset: number, width: number): number {
  if (width <= 0 || width > 32) throw new RangeError(`extractBits: bad width ${width}`);
  if (offset < 0 || offset + width > 32) throw new RangeError(`extractBits: bad offset ${offset}/${width}`);
  const mask = width === 32 ? 0xffffffff : (1 << width) - 1;
  return ((word >>> offset) & mask) >>> 0;
}
