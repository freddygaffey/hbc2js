// tools/native-fixture/writer.mjs — a tiny little-endian byte writer shared by
// the DEX/AXML/ARSC/zip builders of the hermetic fixture generator.
// docs/specs/27-native-side.md §3.
export class W {
  constructor() {
    this.buf = Buffer.alloc(1024);
    this.len = 0;
  }
  #need(n) {
    while (this.len + n > this.buf.length) {
      const bigger = Buffer.alloc(this.buf.length * 2);
      this.buf.copy(bigger, 0, 0, this.len);
      this.buf = bigger;
    }
  }
  get pos() {
    return this.len;
  }
  u1(v) {
    this.#need(1);
    this.buf.writeUInt8(v & 0xff, this.len);
    this.len += 1;
    return this;
  }
  u2(v) {
    this.#need(2);
    this.buf.writeUInt16LE(v & 0xffff, this.len);
    this.len += 2;
    return this;
  }
  u4(v) {
    this.#need(4);
    this.buf.writeUInt32LE(v >>> 0, this.len);
    this.len += 4;
    return this;
  }
  bytes(b) {
    this.#need(b.length);
    Buffer.from(b).copy(this.buf, this.len);
    this.len += b.length;
    return this;
  }
  uleb(v) {
    let x = v >>> 0;
    for (;;) {
      const byte = x & 0x7f;
      x >>>= 7;
      if (x === 0) {
        this.u1(byte);
        return this;
      }
      this.u1(byte | 0x80);
    }
  }
  align(n) {
    while (this.len % n !== 0) this.u1(0);
    return this;
  }
  patch4(at, v) {
    this.buf.writeUInt32LE(v >>> 0, at);
    return this;
  }
  out() {
    return this.buf.subarray(0, this.len);
  }
}

/** MUTF-8 as DEX stores strings (ASCII-only fixtures, but written honestly). */
export function mutf8(s) {
  const out = [];
  for (const ch of [...s].map((c) => c.charCodeAt(0))) {
    if (ch !== 0 && ch < 0x80) out.push(ch);
    else if (ch < 0x800) out.push(0xc0 | (ch >> 6), 0x80 | (ch & 0x3f));
    else out.push(0xe0 | (ch >> 12), 0x80 | ((ch >> 6) & 0x3f), 0x80 | (ch & 0x3f));
  }
  return Buffer.from(out);
}

/** DEX string_ids must be sorted by MUTF-8 byte order. */
export function mutf8Compare(a, b) {
  return Buffer.compare(mutf8(a), mutf8(b));
}

export function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A stored-only zip (APK). Read-only fixtures: small, deterministic bytes. */
export function buildZip(entries) {
  const local = new W();
  const central = new W();
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const offset = local.pos;
    local.u4(0x04034b50).u2(20).u2(0).u2(0).u2(0).u2(0);
    local.u4(crc).u4(data.length).u4(data.length).u2(nameBytes.length).u2(0);
    local.bytes(nameBytes).bytes(data);
    central.u4(0x02014b50).u2(20).u2(20).u2(0).u2(0).u2(0).u2(0);
    central.u4(crc).u4(data.length).u4(data.length);
    central.u2(nameBytes.length).u2(0).u2(0).u2(0).u2(0).u4(0).u4(offset);
    central.bytes(nameBytes);
  }
  const out = new W();
  out.bytes(local.out());
  const dirOffset = out.pos;
  out.bytes(central.out());
  out.u4(0x06054b50).u2(0).u2(0).u2(entries.length).u2(entries.length).u4(central.pos).u4(dirOffset).u2(0);
  return Buffer.from(out.out());
}
