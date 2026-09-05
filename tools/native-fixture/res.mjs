// tools/native-fixture/res.mjs — hand-authored binary AndroidManifest.xml
// (AXML) and resources.arsc writers for the hermetic fixture of
// docs/specs/27-native-side.md §3. Layout from the public AOSP resource-format
// documentation; the bytes are ours, no real app is involved.
import { W } from "./writer.mjs";

const RES_STRING_POOL_TYPE = 0x0001;
const RES_TABLE_TYPE = 0x0002;
const RES_XML_TYPE = 0x0003;
const RES_XML_START_NAMESPACE_TYPE = 0x0100;
const RES_XML_END_NAMESPACE_TYPE = 0x0101;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;
const RES_TABLE_TYPE_SPEC_TYPE = 0x0202;

export const ANDROID_NS = "http://schemas.android.com/apk/res/android";

/** Public `android:` attribute resource ids (AOSP public.xml). They matter
 *  only to external tools reading the fixture; our own decoder keys on the
 *  attribute NAME string, never on these ids. */
const ATTR_IDS = {
  name: 0x01010003,
  label: 0x01010001,
  exported: 0x01010010,
  scheme: 0x01010027,
  host: 0x01010028,
  pathPrefix: 0x0101002c,
  minSdkVersion: 0x0101020c,
  targetSdkVersion: 0x01010270,
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
};

/** A `ResStringPool` chunk. `utf8:false` writes UTF-16 (AXML's usual form),
 *  `utf8:true` writes UTF-8 (what aapt2 emits for resources.arsc) — the
 *  fixture deliberately uses one of each so both reader paths are exercised. */
function stringPool(strings, utf8) {
  const data = new W();
  const offsets = [];
  for (const s of strings) {
    offsets.push(data.pos);
    if (utf8) {
      const bytes = Buffer.from(s, "utf8");
      data.u1(s.length).u1(bytes.length).bytes(bytes).u1(0);
    } else {
      data.u2(s.length);
      for (let i = 0; i < s.length; i++) data.u2(s.charCodeAt(i));
      data.u2(0);
    }
  }
  data.align(4);
  const headerSize = 0x1c;
  const stringsStart = headerSize + 4 * strings.length;
  const w = new W();
  w.u2(RES_STRING_POOL_TYPE).u2(headerSize).u4(stringsStart + data.pos);
  w.u4(strings.length).u4(0).u4(utf8 ? 1 << 8 : 0).u4(stringsStart).u4(0);
  for (const o of offsets) w.u4(o);
  w.bytes(data.out());
  return Buffer.from(w.out());
}

/** Build binary XML from a small element tree:
 *  `{name, attrs:[{ns,name,value}], children:[...]}` where `value` is
 *  `{s:"..."} | {int:n} | {bool:true}`. */
export function buildAxml(root) {
  // Attribute-name strings come first so the resource map (one id per pool
  // index) lines up, exactly as aapt emits it.
  const attrNames = [];
  const others = [];
  const addOther = (s) => {
    if (s !== null && !others.includes(s)) others.push(s);
  };
  const walk = (el) => {
    for (const a of el.attrs ?? []) {
      if (a.ns === ANDROID_NS && !attrNames.includes(a.name)) attrNames.push(a.name);
    }
    for (const c of el.children ?? []) walk(c);
  };
  walk(root);
  const walk2 = (el) => {
    for (const a of el.attrs ?? []) {
      if (a.ns !== ANDROID_NS) addOther(a.name);
      if (a.value && "s" in a.value) addOther(a.value.s);
    }
    addOther(el.name);
    for (const c of el.children ?? []) walk2(c);
  };
  addOther("android");
  addOther(ANDROID_NS);
  walk2(root);
  const strings = [...attrNames, ...others];
  const idx = (s) => (s === null ? 0xffffffff : strings.indexOf(s));

  const body = new W();
  const node = (type, extraLen, write) => {
    body.u2(type).u2(0x10).u4(0x10 + extraLen).u4(1).u4(0xffffffff);
    write(body);
  };
  node(RES_XML_START_NAMESPACE_TYPE, 8, (w) => w.u4(idx("android")).u4(idx(ANDROID_NS)));
  const emit = (el) => {
    const attrs = el.attrs ?? [];
    node(RES_XML_START_ELEMENT_TYPE, 20 + 20 * attrs.length, (w) => {
      w.u4(0xffffffff).u4(idx(el.name));
      w.u2(0x14).u2(0x14).u2(attrs.length).u2(0).u2(0).u2(0);
      for (const a of attrs) {
        w.u4(a.ns === null ? 0xffffffff : idx(a.ns)).u4(idx(a.name));
        if ("s" in a.value) w.u4(idx(a.value.s)).u2(8).u1(0).u1(0x03).u4(idx(a.value.s));
        else if ("int" in a.value) w.u4(0xffffffff).u2(8).u1(0).u1(0x10).u4(a.value.int);
        else w.u4(0xffffffff).u2(8).u1(0).u1(0x12).u4(a.value.bool ? 0xffffffff : 0);
      }
    });
    for (const c of el.children ?? []) emit(c);
    node(RES_XML_END_ELEMENT_TYPE, 8, (w) => w.u4(0xffffffff).u4(idx(el.name)));
  };
  emit(root);
  node(RES_XML_END_NAMESPACE_TYPE, 8, (w) => w.u4(idx("android")).u4(idx(ANDROID_NS)));

  const pool = stringPool(strings, false);
  const resMap = new W();
  resMap.u2(RES_XML_RESOURCE_MAP_TYPE).u2(8).u4(8 + 4 * attrNames.length);
  for (const n of attrNames) resMap.u4(ATTR_IDS[n] ?? 0);

  const w = new W();
  w.u2(RES_XML_TYPE).u2(8).u4(8 + pool.length + resMap.pos + body.pos);
  w.bytes(pool).bytes(resMap.out()).bytes(body.out());
  return Buffer.from(w.out());
}

/** Build a one-package `resources.arsc`.
 *  `entries`: `[{type:"string", name:"x", value:{s:"..."} | {ref:0x7f010001}}]`
 *  in id order per type. */
export function buildArsc(pkgId, pkgName, entries) {
  const values = [];
  for (const e of entries) if ("s" in e.value && !values.includes(e.value.s)) values.push(e.value.s);
  const globalPool = stringPool(values, true);

  const typeNames = [];
  for (const e of entries) if (!typeNames.includes(e.type)) typeNames.push(e.type);
  const keyNames = entries.map((e) => e.name);
  const typePool = stringPool(typeNames, true);
  const keyPool = stringPool(keyNames, true);

  const inner = new W();
  for (const [ti, typeName] of typeNames.entries()) {
    const typeId = ti + 1;
    const ofType = entries.filter((e) => e.type === typeName);
    const spec = new W();
    spec.u2(RES_TABLE_TYPE_SPEC_TYPE).u2(16).u4(16 + 4 * ofType.length).u1(typeId).u1(0).u2(0).u4(ofType.length);
    for (let i = 0; i < ofType.length; i++) spec.u4(0);
    inner.bytes(spec.out());

    const CONFIG_SIZE = 64;
    const headerSize = 20 + CONFIG_SIZE;
    const entriesStart = headerSize + 4 * ofType.length;
    const data = new W();
    const offsets = [];
    for (const e of ofType) {
      offsets.push(data.pos);
      data.u2(8).u2(0).u4(keyNames.indexOf(e.name));
      if ("s" in e.value) data.u2(8).u1(0).u1(0x03).u4(values.indexOf(e.value.s));
      else data.u2(8).u1(0).u1(0x01).u4(e.value.ref);
    }
    const t = new W();
    t.u2(RES_TABLE_TYPE_TYPE).u2(headerSize).u4(entriesStart + data.pos).u1(typeId).u1(0).u2(0).u4(ofType.length).u4(entriesStart);
    t.u4(CONFIG_SIZE);
    for (let i = 4; i < CONFIG_SIZE; i++) t.u1(0); // the default (all-zero) config
    for (const o of offsets) t.u4(o);
    t.bytes(data.out());
    inner.bytes(t.out());
  }

  const PKG_HEADER = 0x120;
  const pkg = new W();
  pkg.u2(RES_TABLE_PACKAGE_TYPE).u2(PKG_HEADER).u4(PKG_HEADER + typePool.length + keyPool.length + inner.pos);
  pkg.u4(pkgId);
  for (let i = 0; i < 128; i++) pkg.u2(i < pkgName.length ? pkgName.charCodeAt(i) : 0);
  pkg.u4(PKG_HEADER).u4(typeNames.length).u4(PKG_HEADER + typePool.length).u4(keyNames.length).u4(0);
  if (pkg.pos !== PKG_HEADER) throw new Error(`package header is ${pkg.pos} bytes, expected ${PKG_HEADER}`);
  pkg.bytes(typePool).bytes(keyPool).bytes(inner.out());

  const w = new W();
  w.u2(RES_TABLE_TYPE).u2(12).u4(12 + globalPool.length + pkg.pos).u4(1);
  w.bytes(globalPool).bytes(pkg.out());
  return Buffer.from(w.out());
}
