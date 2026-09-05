// Binding identity — docs/specs/rename-tool-DESIGN-D-overlay.md §3.
//
// Every nameable binding gets a stable, serialisable id derived from the
// compiled binary, identical across decompiler runs and independent of emitted
// text. v1 owns the register-local kind only; env-slot and function kinds are
// reserved in the shape (spec §8) but refused until closure-naming / fn-naming
// key into the overlay (docs/name-overlay-feasibility.md).

/** A register local: register `reg` of Hermes bytecode function `fn`. The
 *  only binding kind v1 applies names to. */
export interface RegisterId {
  readonly kind: "reg";
  readonly fn: number;
  readonly reg: number;
}

/** An environment slot (spec §8) — reserved; v1 stores but never renders one,
 *  since slot identity is closure-naming's model, which is not built yet. */
export interface EnvId {
  readonly kind: "env";
  readonly fn: number;
  readonly env: number;
}

/** A function (spec §8) — reserved for v1.1. */
export interface FnId {
  readonly kind: "fn";
  readonly fn: number;
}

export type BindingId = RegisterId | EnvId | FnId;

/** Construct a register-local id. */
export function regId(fn: number, reg: number): RegisterId {
  return { kind: "reg", fn, reg };
}

/** A stable, order-independent string key for a binding id — the map key the
 *  store groups a binding's history under, and what a caller can round-trip
 *  through `parseKey`. */
export function bindingKey(id: BindingId): string {
  switch (id.kind) {
    case "reg":
      return `reg:${id.fn}:${id.reg}`;
    case "env":
      return `env:${id.fn}:${id.env}`;
    case "fn":
      return `fn:${id.fn}`;
  }
}

/** Inverse of `bindingKey`. Throws on a malformed key. */
export function parseKey(key: string): BindingId {
  const parts = key.split(":");
  if (parts[0] === "reg" && parts.length === 3) return { kind: "reg", fn: Number(parts[1]), reg: Number(parts[2]) };
  if (parts[0] === "env" && parts.length === 3) return { kind: "env", fn: Number(parts[1]), env: Number(parts[2]) };
  if (parts[0] === "fn" && parts.length === 2) return { kind: "fn", fn: Number(parts[1]) };
  throw new Error(`malformed binding key: ${JSON.stringify(key)}`);
}

/** The `{fn,reg}` short form the spec's token-minimal output uses:
 *  `named {42,7} → …`. Register ids only. */
export function shortForm(id: RegisterId): string {
  return `{${id.fn},${id.reg}}`;
}

// --- Native-side binding keys (docs/specs/27-native-side.md §L1) ------------
// Namespaced siblings of the `reg:`/`env:`/`fn:` keys above: they name things
// in the APK's native half (DEX types/methods/strings, ARSC resources) in the
// SAME id space the project store annotates, so a finding can cite a native
// row the way it cites a JS binding. They are deliberately NOT part of
// `BindingId`: v1 never renames a native entity, it only refers to one, so
// `parseKey` keeps refusing them.

/** The native id kinds spec 27 §L1 defines. */
export type NativeIdKind = "type" | "method" | "str" | "res";

/** `native:<kind>:<value>` — the one place these keys are constructed. */
export function nativeKey(kind: NativeIdKind, value: string): string {
  return `native:${kind}:${value}`;
}

/** `native:type:Lcom/x/Foo;` for a DEX type descriptor. */
export function nativeTypeKey(descriptor: string): string {
  return nativeKey("type", descriptor);
}

/** `native:method:Lcom/x/Foo;->bar(I)V` — class descriptor, name, proto. */
export function nativeMethodKey(classDescriptor: string, name: string, proto: string): string {
  return nativeKey("method", `${classDescriptor}->${name}${proto}`);
}

/** `native:str:<dexStringIndex>`. */
export function nativeStringKey(index: number): string {
  return nativeKey("str", String(index));
}

/** `native:res:<pkg>/<type>/<name>`. */
export function nativeResourceKey(pkg: string, type: string, name: string): string {
  return nativeKey("res", `${pkg}/${type}/${name}`);
}

/** True for any key in the native namespace (the project store's guard). */
export function isNativeKey(key: string): boolean {
  return key.startsWith("native:");
}
