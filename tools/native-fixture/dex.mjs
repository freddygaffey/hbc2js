// tools/native-fixture/dex.mjs — hand-authored DEX writer for the hermetic
// fixture of docs/specs/27-native-side.md §3. We are both the producer and the
// consumer of the parser, so the fixture is a known-good byte sequence we own
// (no real app, no JVM, nothing downloaded).
//
// Layout written from the public AOSP `dex-format` documentation. Tables are
// emitted in the canonical sort order the format requires so an external tool
// (baksmali, off-gate) can read the same bytes.
import { createHash } from "node:crypto";
import { adler32, mutf8, mutf8Compare, W } from "./writer.mjs";

const TYPE_HEADER = 0x0000;
const TYPE_STRING_ID = 0x0001;
const TYPE_TYPE_ID = 0x0002;
const TYPE_PROTO_ID = 0x0003;
const TYPE_FIELD_ID = 0x0004;
const TYPE_METHOD_ID = 0x0005;
const TYPE_CLASS_DEF = 0x0006;
const TYPE_MAP_LIST = 0x1000;
const TYPE_TYPE_LIST = 0x1001;
const TYPE_ANNOTATION_SET = 0x1003;
const TYPE_CLASS_DATA = 0x2000;
const TYPE_STRING_DATA = 0x2002;
const TYPE_ANNOTATION = 0x2004;
const TYPE_ENCODED_ARRAY = 0x2005;
const TYPE_ANNOTATIONS_DIRECTORY = 0x2006;

function shortyOf(descriptor) {
  return descriptor.startsWith("L") || descriptor.startsWith("[") ? "L" : descriptor;
}

function protoKey(p) {
  return `(${p.params.join("")})${p.ret}`;
}

function collectAnnotationStrings(anns, addStr, addType) {
  for (const a of anns ?? []) {
    addType(a.type);
    for (const [name, v] of Object.entries(a.elements ?? {})) {
      addStr(name);
      if (v && typeof v === "object" && "string" in v) addStr(v.string);
      if (v && typeof v === "object" && "type" in v) addType(v.type);
    }
  }
}

/** Build one `classes*.dex` from a declarative class list. */
export function buildDex(classes) {
  const strings = new Set();
  const types = new Set();
  const addStr = (s) => strings.add(s);
  const addType = (t) => {
    types.add(t);
    strings.add(t);
  };

  const protoSet = new Map();
  const fieldSet = new Map();
  const methodSet = new Map();

  for (const c of classes) {
    addType(c.name);
    if (c.super) addType(c.super);
    for (const i of c.interfaces ?? []) addType(i);
    if (c.sourceFile) addStr(c.sourceFile);
    collectAnnotationStrings(c.annotations, addStr, addType);
    for (const f of c.staticFields ?? []) {
      addStr(f.name);
      addType(f.type);
      if (f.value && typeof f.value === "object" && "string" in f.value) addStr(f.value.string);
      fieldSet.set(`${c.name}->${f.name}:${f.type}`, { class: c.name, name: f.name, type: f.type });
    }
    for (const m of [...(c.directMethods ?? []), ...(c.virtualMethods ?? [])]) {
      addStr(m.name);
      addType(m.ret);
      for (const p of m.params ?? []) addType(p);
      const proto = { ret: m.ret, params: m.params ?? [] };
      const key = protoKey(proto);
      proto.shorty = shortyOf(m.ret) + (m.params ?? []).map(shortyOf).join("");
      addStr(proto.shorty);
      if (!protoSet.has(key)) protoSet.set(key, proto);
      methodSet.set(`${c.name}->${m.name}${key}`, { class: c.name, name: m.name, protoKey: key });
      collectAnnotationStrings(m.annotations, addStr, addType);
    }
  }

  const stringList = [...strings].sort(mutf8Compare);
  const sIdx = new Map(stringList.map((s, i) => [s, i]));
  const typeList = [...types].sort((a, b) => sIdx.get(a) - sIdx.get(b));
  const tIdx = new Map(typeList.map((t, i) => [t, i]));

  const protoList = [...protoSet.values()].sort((a, b) => {
    if (tIdx.get(a.ret) !== tIdx.get(b.ret)) return tIdx.get(a.ret) - tIdx.get(b.ret);
    const n = Math.min(a.params.length, b.params.length);
    for (let i = 0; i < n; i++) if (tIdx.get(a.params[i]) !== tIdx.get(b.params[i])) return tIdx.get(a.params[i]) - tIdx.get(b.params[i]);
    return a.params.length - b.params.length;
  });
  const pIdx = new Map(protoList.map((p, i) => [protoKey(p), i]));

  const fieldList = [...fieldSet.values()].sort(
    (a, b) => tIdx.get(a.class) - tIdx.get(b.class) || sIdx.get(a.name) - sIdx.get(b.name) || tIdx.get(a.type) - tIdx.get(b.type),
  );
  const fIdx = new Map(fieldList.map((f, i) => [`${f.class}->${f.name}:${f.type}`, i]));

  const methodList = [...methodSet.values()].sort(
    (a, b) => tIdx.get(a.class) - tIdx.get(b.class) || sIdx.get(a.name) - sIdx.get(b.name) || pIdx.get(a.protoKey) - pIdx.get(b.protoKey),
  );
  const mIdx = new Map(methodList.map((m, i) => [`${m.class}->${m.name}${m.protoKey}`, i]));

  // --- section sizes / offsets ------------------------------------------
  const HEADER = 0x70;
  const stringIdsOff = HEADER;
  const typeIdsOff = stringIdsOff + 4 * stringList.length;
  const protoIdsOff = typeIdsOff + 4 * typeList.length;
  const fieldIdsOff = protoIdsOff + 12 * protoList.length;
  const methodIdsOff = fieldIdsOff + 8 * fieldList.length;
  const classDefsOff = methodIdsOff + 8 * methodList.length;
  const dataOff = classDefsOff + 32 * classes.length;

  // --- data section -------------------------------------------------------
  const d = new W();
  const at = () => dataOff + d.pos;

  const stringDataOff = new Map();
  for (const s of stringList) {
    stringDataOff.set(s, at());
    d.uleb(s.length).bytes(mutf8(s)).u1(0);
  }

  const typeListOff = new Map();
  const emitTypeList = (list) => {
    if (list.length === 0) return 0;
    const key = list.join("");
    if (typeListOff.has(key)) return typeListOff.get(key);
    d.align(4);
    const off = at();
    d.u4(list.length);
    for (const t of list) d.u2(tIdx.get(t));
    typeListOff.set(key, off);
    return off;
  };
  for (const p of protoList) emitTypeList(p.params);
  for (const c of classes) emitTypeList(c.interfaces ?? []);

  const encodeValue = (w, v) => {
    if (v === null) return w.u1((0 << 5) | 0x1e);
    if (typeof v === "boolean") return w.u1(((v ? 1 : 0) << 5) | 0x1f);
    if (typeof v === "number") {
      w.u1((3 << 5) | 0x04);
      return w.u4(v | 0);
    }
    if (typeof v === "object" && "string" in v) {
      w.u1((3 << 5) | 0x17);
      return w.u4(sIdx.get(v.string));
    }
    if (typeof v === "object" && "type" in v) {
      w.u1((3 << 5) | 0x18);
      return w.u4(tIdx.get(v.type));
    }
    if (Array.isArray(v)) {
      w.u1((0 << 5) | 0x1c);
      w.uleb(v.length);
      for (const x of v) encodeValue(w, x);
      return w;
    }
    throw new Error(`unsupported encoded_value ${JSON.stringify(v)}`);
  };

  const emitAnnotationItem = (a) => {
    const off = at();
    d.u1(a.visibility ?? 1); // 0 build, 1 runtime, 2 system
    d.uleb(tIdx.get(a.type));
    const elements = Object.entries(a.elements ?? {}).sort((x, y) => sIdx.get(x[0]) - sIdx.get(y[0]));
    d.uleb(elements.length);
    for (const [name, v] of elements) {
      d.uleb(sIdx.get(name));
      encodeValue(d, v);
    }
    return off;
  };

  const emitAnnotationSet = (anns) => {
    if (!anns || anns.length === 0) return 0;
    const itemOffs = anns.map(emitAnnotationItem);
    d.align(4);
    const off = at();
    d.u4(itemOffs.length);
    for (const o of itemOffs) d.u4(o);
    return off;
  };

  const dirOff = new Map();
  for (const c of classes) {
    const classSet = emitAnnotationSet(c.annotations);
    const annotated = [];
    for (const m of [...(c.directMethods ?? []), ...(c.virtualMethods ?? [])]) {
      if (!m.annotations || m.annotations.length === 0) continue;
      annotated.push({ idx: mIdx.get(`${c.name}->${m.name}(${(m.params ?? []).join("")})${m.ret}`), set: emitAnnotationSet(m.annotations) });
    }
    if (classSet === 0 && annotated.length === 0) continue;
    annotated.sort((a, b) => a.idx - b.idx);
    d.align(4);
    const off = at();
    d.u4(classSet).u4(0).u4(annotated.length).u4(0);
    for (const a of annotated) d.u4(a.idx).u4(a.set);
    dirOff.set(c.name, off);
  }

  const staticValuesOff = new Map();
  for (const c of classes) {
    const withValues = (c.staticFields ?? []).filter((f) => f.value !== undefined);
    if (withValues.length === 0) continue;
    const off = at();
    d.uleb(withValues.length);
    for (const f of withValues) encodeValue(d, f.value);
    staticValuesOff.set(c.name, off);
  }

  const classDataOff = new Map();
  for (const c of classes) {
    const statics = (c.staticFields ?? []).slice().sort((a, b) => fIdx.get(`${c.name}->${a.name}:${a.type}`) - fIdx.get(`${c.name}->${b.name}:${b.type}`));
    const direct = (c.directMethods ?? []).slice();
    const virtual = (c.virtualMethods ?? []).slice();
    if (statics.length === 0 && direct.length === 0 && virtual.length === 0) continue;
    const off = at();
    d.uleb(statics.length).uleb(0).uleb(direct.length).uleb(virtual.length);
    let prev = 0;
    for (const f of statics) {
      const idx = fIdx.get(`${c.name}->${f.name}:${f.type}`);
      d.uleb(idx - prev).uleb(f.access ?? 0x19);
      prev = idx;
    }
    for (const group of [direct, virtual]) {
      const sorted = group
        .map((m) => ({ m, idx: mIdx.get(`${c.name}->${m.name}(${(m.params ?? []).join("")})${m.ret}`) }))
        .sort((a, b) => a.idx - b.idx);
      let p = 0;
      for (const { m, idx } of sorted) {
        d.uleb(idx - p).uleb(m.access ?? 0x1).uleb(0); // code_off 0: no bodies
        p = idx;
      }
    }
    classDataOff.set(c.name, off);
  }

  d.align(4);
  const mapOff = at();
  const mapEntries = [
    [TYPE_HEADER, 1, 0],
    [TYPE_STRING_ID, stringList.length, stringIdsOff],
    [TYPE_TYPE_ID, typeList.length, typeIdsOff],
    [TYPE_PROTO_ID, protoList.length, protoIdsOff],
    [TYPE_FIELD_ID, fieldList.length, fieldIdsOff],
    [TYPE_METHOD_ID, methodList.length, methodIdsOff],
    [TYPE_CLASS_DEF, classes.length, classDefsOff],
    [TYPE_STRING_DATA, stringList.length, stringDataOff.get(stringList[0])],
    [TYPE_TYPE_LIST, typeListOff.size, [...typeListOff.values()][0]],
    [TYPE_ANNOTATION, 0, 0],
    [TYPE_ANNOTATION_SET, 0, 0],
    [TYPE_ANNOTATIONS_DIRECTORY, dirOff.size, [...dirOff.values()][0]],
    [TYPE_ENCODED_ARRAY, staticValuesOff.size, [...staticValuesOff.values()][0]],
    [TYPE_CLASS_DATA, classDataOff.size, [...classDataOff.values()][0]],
    [TYPE_MAP_LIST, 1, mapOff],
  ]
    .filter(([, size]) => size > 0)
    .sort((a, b) => (a[2] ?? 0) - (b[2] ?? 0));
  d.u4(mapEntries.length);
  for (const [type, size, off] of mapEntries) d.u2(type).u2(0).u4(size).u4(off ?? 0);

  const dataSize = d.pos;

  // --- header + tables ----------------------------------------------------
  const w = new W();
  w.bytes(Buffer.from("dex\n035\0", "binary"));
  w.u4(0); // checksum, patched below
  w.bytes(Buffer.alloc(20)); // signature, patched below
  w.u4(0); // file_size, patched
  w.u4(HEADER).u4(0x12345678);
  w.u4(0).u4(0); // link_size, link_off
  w.u4(mapOff);
  w.u4(stringList.length).u4(stringIdsOff);
  w.u4(typeList.length).u4(typeIdsOff);
  w.u4(protoList.length).u4(protoIdsOff);
  w.u4(fieldList.length).u4(fieldIdsOff);
  w.u4(methodList.length).u4(methodIdsOff);
  w.u4(classes.length).u4(classDefsOff);
  w.u4(dataSize).u4(dataOff);
  if (w.pos !== HEADER) throw new Error(`dex header is ${w.pos} bytes, expected ${HEADER}`);

  for (const s of stringList) w.u4(stringDataOff.get(s));
  for (const t of typeList) w.u4(sIdx.get(t));
  for (const p of protoList) w.u4(sIdx.get(p.shorty)).u4(tIdx.get(p.ret)).u4(p.params.length === 0 ? 0 : typeListOff.get(p.params.join("")));
  for (const f of fieldList) w.u2(tIdx.get(f.class)).u2(tIdx.get(f.type)).u4(sIdx.get(f.name));
  for (const m of methodList) w.u2(tIdx.get(m.class)).u2(pIdx.get(m.protoKey)).u4(sIdx.get(m.name));
  for (const c of classes) {
    w.u4(tIdx.get(c.name));
    w.u4(c.access ?? 0x1);
    w.u4(c.super ? tIdx.get(c.super) : 0xffffffff);
    w.u4(emitTypeListOffsetOnly(c.interfaces ?? [], typeListOff));
    w.u4(c.sourceFile ? sIdx.get(c.sourceFile) : 0xffffffff);
    w.u4(dirOff.get(c.name) ?? 0);
    w.u4(classDataOff.get(c.name) ?? 0);
    w.u4(staticValuesOff.get(c.name) ?? 0);
  }
  if (w.pos !== dataOff) throw new Error(`dex tables end at ${w.pos}, expected data_off ${dataOff}`);
  w.bytes(d.out());

  const out = Buffer.from(w.out());
  out.writeUInt32LE(out.length, 32); // file_size
  const sha = createHash("sha1").update(out.subarray(32)).digest();
  sha.copy(out, 12);
  out.writeUInt32LE(adler32(out.subarray(12)), 8);
  return out;
}

function emitTypeListOffsetOnly(list, typeListOff) {
  return list.length === 0 ? 0 : typeListOff.get(list.join(""));
}
