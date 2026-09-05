// src/native/axml.ts — a minimal binary-XML (AXML) decoder for
// AndroidManifest.xml. docs/specs/27-native-side.md §L1.2.
//
// Produces a small element tree, then the `native/manifest.json` contract.
// Truth rule (§L1): an absent `android:exported` is `null` (unknown), never a
// guessed boolean; anything we cannot decode becomes a `notes` entry, not a
// fabricated value.
import {
  eachChunk,
  readChunk,
  readResValue,
  readStringPool,
  RES_STRING_POOL_TYPE,
  RES_XML_END_ELEMENT_TYPE,
  RES_XML_START_ELEMENT_TYPE,
  RES_XML_TYPE,
  resErr,
  ru16,
  ru32,
  TYPE_INT_BOOLEAN,
  TYPE_INT_DEC,
  TYPE_INT_HEX,
  TYPE_REFERENCE,
  TYPE_STRING,
  type ResStringPool,
} from "./restable.ts";
import type { NativeManifest, NativeManifestComponent } from "./schema.ts";

export const ANDROID_NS = "http://schemas.android.com/apk/res/android";

export interface AxmlAttribute {
  readonly ns: string | null;
  readonly name: string;
  /** Decoded value: a string, number or boolean; `{ref:...}` for a reference. */
  readonly value: string | number | boolean | { readonly ref: string } | null;
}

export interface AxmlElement {
  readonly name: string;
  readonly attributes: readonly AxmlAttribute[];
  readonly children: AxmlElement[];
}

/** True when `bytes` starts with the AXML chunk magic (§L1.2: we only claim a
 *  real decode when the magic is present; `apk.ts`'s heuristic is the fallback). */
export function looksLikeAxml(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && ru16(bytes, 0) === RES_XML_TYPE;
}

/** Decode binary XML into an element tree. Throws on a malformed chunk. */
export function parseAxml(bytes: Uint8Array): AxmlElement {
  const root = readChunk(bytes, 0);
  if (root.type !== RES_XML_TYPE) throw resErr(`not binary XML (chunk type 0x${root.type.toString(16)})`, 0);
  let pool: ResStringPool | null = null;
  const stack: AxmlElement[] = [];
  let top: AxmlElement | null = null;

  eachChunk(bytes, root.headerSize, Math.min(root.size, bytes.length), (c) => {
    if (c.type === RES_STRING_POOL_TYPE) {
      pool = readStringPool(bytes, c);
      return;
    }
    if (c.type === RES_XML_START_ELEMENT_TYPE) {
      if (pool === null) throw resErr("start-element before the string pool", c.offset);
      const p: ResStringPool = pool;
      const o = c.offset + c.headerSize;
      const name = p.at(ru32(bytes, o + 4)) ?? "?";
      const attrStart = ru16(bytes, o + 8);
      const attrSize = ru16(bytes, o + 10);
      const attrCount = ru16(bytes, o + 12);
      const attributes: AxmlAttribute[] = [];
      for (let i = 0; i < attrCount; i++) {
        const a = o + attrStart + i * attrSize;
        const ns = p.at(ru32(bytes, a));
        const attrName = p.at(ru32(bytes, a + 4)) ?? "?";
        const rawValue = p.at(ru32(bytes, a + 8));
        const v = readResValue(bytes, a + 12);
        attributes.push({ ns, name: attrName, value: decodeAttrValue(v.dataType, v.data, rawValue, p) });
      }
      const el: AxmlElement = { name, attributes, children: [] };
      if (stack.length > 0) stack[stack.length - 1]!.children.push(el);
      else top = el;
      stack.push(el);
      return;
    }
    if (c.type === RES_XML_END_ELEMENT_TYPE) {
      stack.pop();
    }
  });

  if (top === null) throw resErr("binary XML has no root element", 0);
  return top;
}

function decodeAttrValue(dataType: number, data: number, rawValue: string | null, pool: ResStringPool): AxmlAttribute["value"] {
  switch (dataType) {
    case TYPE_STRING:
      return pool.at(data) ?? rawValue;
    case TYPE_INT_BOOLEAN:
      return data !== 0;
    case TYPE_INT_DEC:
      return data | 0;
    case TYPE_INT_HEX:
      return data >>> 0;
    case TYPE_REFERENCE:
      return { ref: `@0x${data.toString(16).padStart(8, "0")}` };
    default:
      return rawValue;
  }
}

function attr(el: AxmlElement, name: string, ns: string | null = ANDROID_NS): AxmlAttribute["value"] | undefined {
  for (const a of el.attributes) {
    if (a.name !== name) continue;
    if (ns === null ? a.ns === null : a.ns === ns) return a.value;
  }
  return undefined;
}

function str(v: AxmlAttribute["value"] | undefined): string | null {
  return typeof v === "string" ? v : null;
}

const COMPONENT_KINDS: Record<string, NativeManifestComponent["kind"]> = {
  activity: "activity",
  "activity-alias": "activity",
  service: "service",
  receiver: "receiver",
  provider: "provider",
};

/** Project a decoded manifest tree onto the `native/manifest.json` contract. */
export function manifestFromAxml(root: AxmlElement, notes: readonly string[] = []): NativeManifest {
  const allNotes = [...notes];
  const permissions: string[] = [];
  const components: NativeManifestComponent[] = [];
  let usesSdkMin: number | null = null;
  let usesSdkTarget: number | null = null;

  const walk = (el: AxmlElement): void => {
    if (el.name === "uses-permission" || el.name === "uses-permission-sdk-23") {
      const n = str(attr(el, "name"));
      if (n !== null) permissions.push(n);
    } else if (el.name === "uses-sdk") {
      const min = attr(el, "minSdkVersion");
      const target = attr(el, "targetSdkVersion");
      if (typeof min === "number") usesSdkMin = min;
      if (typeof target === "number") usesSdkTarget = target;
    } else {
      const kind = COMPONENT_KINDS[el.name];
      if (kind !== undefined) {
        const name = str(attr(el, "name"));
        if (name === null) {
          allNotes.push(`a <${el.name}> element has no android:name; it is recorded with an empty name rather than skipped`);
        }
        const exportedAttr = attr(el, "exported");
        components.push({
          kind,
          name: name ?? "",
          // Truth rule (§L1): absent attribute => unknown, never a default guess.
          exported: typeof exportedAttr === "boolean" ? exportedAttr : null,
          intentFilters: el.children.filter((c) => c.name === "intent-filter").map(intentFilter),
        });
      }
    }
    for (const c of el.children) walk(c);
  };
  walk(root);

  const versionCode = attr(root, "versionCode");
  return {
    package: str(attr(root, "package", null)),
    versionName: str(attr(root, "versionName")),
    versionCode: typeof versionCode === "number" ? versionCode : null,
    permissions: permissions.sort(),
    usesSdk: { min: usesSdkMin, target: usesSdkTarget },
    components: components.sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind < b.kind ? -1 : 1)),
    notes: allNotes,
  };
}

function intentFilter(el: AxmlElement): NativeManifestComponent["intentFilters"][number] {
  const actions: string[] = [];
  const categories: string[] = [];
  const data: { scheme: string | null; host: string | null; pathPrefix: string | null }[] = [];
  for (const c of el.children) {
    if (c.name === "action") {
      const n = str(attr(c, "name"));
      if (n !== null) actions.push(n);
    } else if (c.name === "category") {
      const n = str(attr(c, "name"));
      if (n !== null) categories.push(n);
    } else if (c.name === "data") {
      data.push({ scheme: str(attr(c, "scheme")), host: str(attr(c, "host")), pathPrefix: str(attr(c, "pathPrefix")) });
    }
  }
  return { actions: actions.sort(), categories: categories.sort(), data };
}

/** An empty, honest manifest: no facts, one note saying why. */
export function emptyManifest(note: string): NativeManifest {
  return { package: null, versionName: null, versionCode: null, permissions: [], usesSdk: { min: null, target: null }, components: [], notes: [note] };
}
